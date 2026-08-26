import crypto from 'crypto';
import { BlockStore } from '../storage';
import { Block, BlockHeader, Transaction, InferenceTask, ComputeNode, AgentAccount, AccountState, VerificationGame } from '../core/types';
import { signMessage, sha256, verifySignature, verifySignatureED, publicKeyToAddress } from '../wallet/crypto';
import { canonicalTxIdOf, canonicalJson } from './canonical';
import { getLayerSpec as zkGetLayerSpec } from '../zk';
import { loadWasmSync, WasmRuntime } from '../wasm/runtime';
import { gasCostFor, gasUsedOf, computeBaseFee, INITIAL_BASE_FEE, blockGasLimit, policyMultiplier, policyOf, isValidPolicy, VerificationPolicy } from './gas';
import { verifyDisputeSnark, DisputeSnark } from '../zk/dispute';

function merkleRoot(hashes: string[]): string {
  if (hashes.length === 0) return sha256('empty-merkle');
  if (hashes.length === 1) return hashes[0];
  const next: string[] = [];
  for (let i = 0; i < hashes.length; i += 2) {
    next.push(sha256(hashes[i] + (hashes[i + 1] ?? hashes[i])));
  }
  return merkleRoot(next);
}

function hashHeader(h: BlockHeader): string {
  return sha256(JSON.stringify({ v: h.version, i: h.index, t: h.timestamp, p: h.previousHash, s: h.stateRoot, tx: h.txRoot, inf: h.inferenceTasksRoot, comp: h.computeRoot, val: h.validator }));
}

export type SignatureScheme = 'legacy' | 'ed25519';

export class AINativeEngine {
  readonly store: BlockStore;
  readonly signatureScheme: SignatureScheme;

  /** In-memory memo of baseFeeAt(height); always derivable from chain data. */
  private baseFeeMemo: { height: number; value: number } | null = null;

  constructor(store: BlockStore, opts: { signatureScheme?: SignatureScheme } = {}) {
    this.signatureScheme = opts.signatureScheme ?? 'legacy';
    this.store = store;
    if (this.store.getChainHeight() < 0) {
      const h: BlockHeader = {
        hash: '', version: 1, index: 0, timestamp: 0,
        previousHash: '0'.repeat(64), validator: 'genesis',
        validatorPubKey: '', validatorSignature: '',
        stateRoot: sha256('genesis'), txRoot: sha256('empty'),
        inferenceTasksRoot: sha256('empty-tasks'), computeRoot: sha256('empty-compute'),
      };
      h.hash = hashHeader(h);
      this.store.saveBlock({ header: h, transactions: [] });
    }
  }

  /**
   * Deterministic EIP-1559 base fee for a given block height, derived purely
   * from chain history so every node computes identical fees:
   *   baseFee(0) = INITIAL_BASE_FEE
   *   baseFee(H) = adjust(baseFee(H-1), gasUsed(block H-1))
   */
  baseFeeAt(height: number): number {
    const latest = this.store.getChainHeight();
    if (
      this.baseFeeMemo &&
      this.baseFeeMemo.height === Math.min(height, latest + 1) &&
      height <= latest + 1
    ) {
      return this.baseFeeMemo.value;
    }
    let v = INITIAL_BASE_FEE;
    for (let h = 1; h <= height; h++) {
      const prevBlock = this.store.getBlockByHeight(h - 1);
      const gasUsed = prevBlock ? gasUsedOf(prevBlock.transactions) : 0;
      v = computeBaseFee(v, gasUsed);
    }
    this.baseFeeMemo = { height: Math.min(height, latest + 1), value: v };
    return v;
  }

  /** Base fee that will apply to the next block to be produced. */
  nextBaseFee(): number {
    return this.baseFeeAt(this.store.getChainHeight() + 1);
  }

  validateTransaction(tx: Transaction): string | true {
    if (!tx.publicKey || !tx.signature) return 'missing sig';
    if (publicKeyToAddress(tx.publicKey) !== tx.from) return 'sig/from mismatch';
    const sigOk =
      this.signatureScheme === 'ed25519'
        ? verifySignatureED(tx.txId, tx.signature, tx.publicKey)
        : verifySignature(tx.txId, tx.signature, tx.publicKey);
    if (!sigOk) return 'invalid sig';
    // Canonical binding: txId must be the hash of the exact unsigned payload.
    // Without this, signed transactions could be malleated after signing.
    if (tx.txId !== canonicalTxIdOf(tx)) return 'txId does not match transaction contents';
    const acc = this.store.getAccount(tx.from);
    if (acc && tx.nonce !== acc.nonce + 1) return `bad nonce (have ${acc.nonce})`;
    const bal = acc?.balance ?? 0;
    const pol = policyOf(tx);
    if (tx.data?.type === 'submitInference') {
      const declared = (tx.data.data as any)?.verificationType;
      if (declared !== undefined && !isValidPolicy(declared)) return `invalid verificationType: ${declared}`;
    }
    const multiplier = pol ? policyMultiplier(pol) : 1;
    const maxFee = gasCostFor(tx) * this.nextBaseFee() * multiplier;
    if (bal < tx.value + maxFee) return 'insufficient balance for value + gas';
    return true;
  }

  /**
   * Apply a transaction's full state transition including mandatory gas fees.
   *
   * Fee handling lives here (not in block production) so that peers applying
   * remote blocks reach byte-identical account state. The fee is split
   * 25% burned to treasury / 75% credited to the block's validator.
   */
  async executeTransaction(tx: Transaction, height: number, validatorAddress?: string): Promise<void> {
    const policy = policyOf(tx);
    const fee = gasCostFor(tx) * this.baseFeeAt(height) * (policy ? policyMultiplier(policy) : 1);

    const acc = this.store.getAccount(tx.from) || {
      address: tx.from, publicKey: tx.publicKey, nonce: 0, balance: 0, updatedAt: 0
    };
    acc.balance -= tx.value + fee;
    if (acc.balance < 0) throw new Error('overdraft');
    acc.nonce = tx.nonce;
    acc.updatedAt = height;
    this.store.setAccount(acc);

    // Route fee: 25% burn / 75% validator
    const payee = validatorAddress || 'treasury';
    const valAcc = this.store.getAccount(payee) || { address: payee, publicKey: '', nonce: 0, balance: 0, updatedAt: 0 };
    valAcc.balance += Math.floor(fee * 0.75);
    valAcc.updatedAt = height;
    this.store.setAccount(valAcc);
    const treasury = this.store.getAccount('treasury') || { address: 'treasury', publicKey: '', nonce: 0, balance: 0, updatedAt: 0 };
    treasury.balance += fee - Math.floor(fee * 0.75);
    this.store.setAccount(treasury);

    if (tx.to && tx.to !== tx.from) {
      const recv = this.store.getAccount(tx.to) || { address: tx.to, publicKey: '', nonce: 0, balance: 0, updatedAt: 0 };
      recv.balance += tx.value;
      recv.updatedAt = height;
      this.store.setAccount(recv);
    }

    const d = tx.data;
    switch (d.type) {
      case 'registerModel': {
        const data = d.data as any;
        const model = {
          ...data,
          modelId: sha256(canonicalJson(data) + tx.txId).substring(0, 32),
          owner: tx.from, registeredAt: height, isActive: true,
        };
        this.store.setModel(model);
        break;
      }
      case 'submitInference': {
        const data = d.data as any;
        const taskId = sha256(canonicalJson(data) + tx.txId).substring(0, 32);
        const verificationType: VerificationPolicy = policy ? policy : 'optimistic';
        this.store.setTask({ ...data, taskId, status: 'pending', verificationType });
        break;
      }
      case 'claimTask': {
        const { taskId } = d.data as { taskId: string };
        const task = this.store.getTask(taskId);
        if (!task || task.status !== 'pending') throw new Error('task unavailable');
        const node = this.store.getNode(tx.from);
        if (!node || !node.supportedModels.includes(task.targetModel)) throw new Error('unsupported model');
        if (node.availableCapacity <= 0) throw new Error('at capacity');
        task.status = 'assigned';
        task.assignedTo = node.nodeId;
        task.collateral = Math.floor(task.maxFee * 0.2);
        this.store.setTask(task);
        node.availableCapacity--;
        node.activeTasks++;
        this.store.setNode(node);
        break;
      }
      case 'submitResult': {
        const { taskId, resultHash, resultOutput, proofData } = d.data as any;
        const task = this.store.getTask(taskId);
        if (!task || task.status !== 'assigned') throw new Error('task not assigned');
        if (task.assignedTo !== tx.from) throw new Error('not assignee');
        task.status = 'completed';
        task.resultHash = resultHash;
        task.resultOutput = resultOutput;
        task.proofData = proofData ?? '';
        task.challengeWindowEnd = height + 100;
        this.store.setTask(task);
        const node = this.store.getNode(tx.from)!;
        node.availableCapacity++;
        node.activeTasks--;
        node.successfulInferences++;
        node.reputation = Math.min(100, node.reputation + 1);
        this.store.setNode(node);
        const nodeAcc = this.store.getAccount(tx.from)!;
        nodeAcc.balance += Math.floor(task.maxFee * 0.8);
        nodeAcc.updatedAt = height;
        this.store.setAccount(nodeAcc);
        break;
      }
      case 'challengeResult': {
        const { taskId, reason } = d.data as { taskId: string; reason: string };
        const task = this.store.getTask(taskId);
        if (!task || task.status !== 'completed') throw new Error('cannot challenge');
        if (height > (task.challengeWindowEnd ?? 0)) throw new Error('challenge window closed');
        
        acc.balance -= task.maxFee; // challenger bond
        if (acc.balance < 0) throw new Error('insufficient challenge bond');
        this.store.setAccount(acc);
        
        const model = this.store.getModel(task.targetModel);
        const architecture = model?.architecture || task.targetModel;
        const gameId = sha256('game' + taskId + tx.from + height).substring(0, 32);
        const layerSpec = zkGetLayerSpec(architecture);
        const gameObj: VerificationGame = {
          gameId,
          taskId,
          challenger: tx.from,
          defender: task.assignedTo!,
          status: 'open',
          low: 0,
          high: layerSpec.length,
          currentStep: 0,
          maxSteps: Math.ceil(Math.log2(layerSpec.length)) + 2,
          challengerCommitments: {},
          defenderCommitments: {},
          disputedLayer: -1,
          challengerBond: task.maxFee,
          defenderBond: task.collateral ?? Math.floor(task.maxFee * 0.2),
          architecture: task.targetModel,
          layerSpec,
          openedAt: height,
          lastMoveAt: height,
          moveTimeout: 5,
        };
        this.store.setGame(gameObj);
        task.status = 'challenged';
        task.gameId = gameId;
        this.store.setTask(task);
        
        const node = this.store.getNode(task.assignedTo!);
        if (node) {
          node.reputation = Math.max(0, node.reputation - 10);
          this.store.setNode(node);
        }
        console.log(`[verif] game ${gameId.slice(0, 16)} opened: "${reason.slice(0, 40)}..."`);
        break;
      }
      case 'bisect': {
        const { gameId, layerIndex, traceRoot } = d.data as { gameId: string; layerIndex: number; traceRoot: string };
        const existingGame = this.store.getGame(gameId) as VerificationGame | undefined;
        if (!existingGame) throw new Error('game not found');
        if (existingGame.status !== 'open' && existingGame.status !== 'bisecting') throw new Error('game not active');
        if (height > existingGame.lastMoveAt + existingGame.moveTimeout) throw new Error('move timeout');
        
        const isChallenger = tx.from === existingGame.challenger;
        const isDefender = tx.from === existingGame.defender;
        if (!isChallenger && !isDefender) throw new Error('not a participant');
        
        const game = { ...existingGame };
        if (isChallenger) game.challengerCommitments = { ...game.challengerCommitments, [layerIndex]: traceRoot };
        else game.defenderCommitments = { ...game.defenderCommitments, [layerIndex]: traceRoot };
        
        const chRoot = game.challengerCommitments[layerIndex];
        const dfRoot = game.defenderCommitments[layerIndex];
        
        if (chRoot && dfRoot) {
          if (chRoot === dfRoot) {
            game.low = layerIndex;
          } else {
            game.high = layerIndex;
            game.disputedLayer = layerIndex;
          }
          game.currentStep++;
        }
        
        if (game.high - game.low <= 1 || game.currentStep >= game.maxSteps) {
          game.status = 'proving';
          game.disputedLayer = Math.floor((game.low + game.high) / 2);
        } else {
          game.status = 'bisecting';
        }
        
        game.lastMoveAt = height;
        this.store.setGame(game);
        console.log(`[verif] bisect step ${game.currentStep} [${game.low}-${game.high}]`);
        break;
      }
      case 'proveStep': {
        const { gameId, layerWeights, layerInput, layerBias, layerOutput, actualTraceRoot, snark } = d.data as any;
        const existingGame = this.store.getGame(gameId) as VerificationGame | undefined;
        if (!existingGame) throw new Error('game not found');
        if (existingGame.status !== 'proving') throw new Error('not at proving stage');
        if (tx.from !== existingGame.defender) throw new Error('only defender can prove');
        if (height > existingGame.lastMoveAt + existingGame.moveTimeout) throw new Error('prove timeout');

        const layerIdx = existingGame.disputedLayer;
        const spec = existingGame.layerSpec[layerIdx];
        if (!spec) throw new Error('invalid disputed layer');

        let isValid: boolean;
        if (snark && snark.proofType && snark.proof && Array.isArray(snark.publicSignals)) {
          // Fast path: a genuine SNARK bound to the claimed output resolves
          // the dispute without re-execution. Anything invalid falls through
          // to deterministic WASM checking, so forgery can never win.
          const inputFixed = (layerInput as number[]).map(v => Math.round(v * 65536));
          const outFixed = (layerOutput as number[]).map(v => Math.round(v * 65536));
          isValid = await verifyDisputeSnark(snark as DisputeSnark, outFixed, inputFixed);
        } else {
          isValid = false;
        }

        if (!isValid) {
          // Deterministic WASM recomputation of the disputed layer output.
          // The defender's claimed output must match the honest execution exactly.
          const runtime = new WasmRuntime(loadWasmSync());
          const recomputedOutput = runtime.executeLayer(spec.opType, layerWeights, layerInput, layerBias);
          isValid = JSON.stringify(recomputedOutput) === JSON.stringify(layerOutput);
        }
        
        const game = { ...existingGame };
        
        if (isValid) {
          game.status = 'resolved_valid';
          game.winner = game.defender;
          game.loser = game.challenger;
          
          const dfAcc = this.store.getAccount(game.defender)!;
          dfAcc.balance += game.challengerBond + game.defenderBond;
          dfAcc.updatedAt = height;
          this.store.setAccount(dfAcc);
          
          const chAcc = this.store.getAccount(game.challenger)!;
          chAcc.balance -= game.challengerBond;
          chAcc.updatedAt = height;
          this.store.setAccount(chAcc);
          
          const defNode = this.store.getNode(game.defender);
          if (defNode) {
            defNode.reputation = Math.min(100, defNode.reputation + 15);
            this.store.setNode(defNode);
          }
          
          const task = this.store.getTask(game.taskId);
          if (task) { task.status = 'completed'; this.store.setTask(task); }
          console.log(`[verif] DEFENDER WINS — challenger slashed ${game.challengerBond}`);
        } else {
          game.status = 'resolved_slash';
          game.winner = game.challenger;
          game.loser = game.defender;
          
          const dfAcc = this.store.getAccount(game.defender)!;
          dfAcc.balance -= game.defenderBond;
          dfAcc.updatedAt = height;
          this.store.setAccount(dfAcc);
          
          const chAcc = this.store.getAccount(game.challenger)!;
          chAcc.balance += game.defenderBond + game.challengerBond;
          chAcc.updatedAt = height;
          this.store.setAccount(chAcc);
          
          const defNode = this.store.getNode(game.defender);
          if (defNode) {
            defNode.reputation = Math.max(0, defNode.reputation - 30);
            defNode.totalSlashed += game.defenderBond;
            this.store.setNode(defNode);
          }
          
          const task = this.store.getTask(game.taskId);
          if (task) { task.status = 'failed'; this.store.setTask(task); }
          console.log(`[verif] CHALLENGER WINS — defender slashed ${game.defenderBond}`);
        }
        
        game.resolvedAt = height;
        game.lastMoveAt = height;
        this.store.setGame(game);
        break;
      }
      case 'registerNode': {
        const data = d.data as any;
        this.store.setNode({ ...data, nodeId: tx.from, publicKey: tx.publicKey, registeredAt: height, lastHeartbeatAt: Date.now(), isActive: true });
        break;
      }
      case 'registerAgent': {
        const data = d.data as any;
        const agent: AgentAccount = {
          address: tx.from, publicKey: tx.publicKey, nonce: 0, balance: 0,
          reputation: 50, totalInferences: 0, totalFeesPaid: 0,
          isAutonomous: true, servicesProvided: {}, updatedAt: height,
          ...data,
        };
        this.store.setAgent(agent);
        break;
      }
      case 'agentPayment': {
        const { fee, provider } = d.data as { fee: number; provider: string };
        const agent = this.store.getAgent(tx.from);
        if (!agent) throw new Error('not an agent');
        const prov = this.store.getAccount(provider) || { address: provider, publicKey: '', nonce: 0, balance: 0, updatedAt: 0 };
        prov.balance += fee;
        prov.updatedAt = height;
        this.store.setAccount(prov);
        agent.totalInferences++;
        agent.totalFeesPaid += fee;
        agent.updatedAt = height;
        this.store.setAgent(agent);
        break;
      }
      case 'transfer': break;
    }
  }

  async produceBlock(txs: Transaction[], validator: { address: string; publicKey: string; privateKey: string }): Promise<Block> {
    const prev = this.store.getLatestBlock()!;
    const height = prev.header.index + 1;
    const executed: Transaction[] = [];
    let gasLeft = blockGasLimit();
    for (const tx of txs) {
      const cost = gasCostFor(tx);
      if (cost > gasLeft) { console.log(`[block] skip ${tx.txId.slice(0, 12)}: block gas limit`); continue; }
      if (this.validateTransaction(tx) === true) {
        try {
          // Mandatory gas fee is applied inside executeTransaction so that
          // peers mirroring this block compute identical account state.
          await this.executeTransaction(tx, height, validator.address);
          executed.push(tx);
          gasLeft -= cost;
        }
        catch (e: any) { console.log(`[exec] failed: ${e.message}`); }
      }
    }

    this.matchPendingTasks(height);
    const txRoot = merkleRoot(executed.map(t => t.txId));
    const sHash = sha256(JSON.stringify({
      accs: Array.from(this.store.getNodes().map(n => `${n.nodeId}:${this.store.getAccount(n.nodeId)?.balance ?? 0}`)),
      models: this.store.getModels().map(m => m.modelId),
      tasks: this.store.getTasksByStatus('pending').map(t => t.taskId),
      nodes: this.store.getNodes().map(n => n.nodeId),
    }));
    const infRoot = merkleRoot(this.store.getTasksByStatus('pending').map(t => t.taskId));
    const compRoot = merkleRoot(this.store.getNodes().map(n => n.nodeId));

    const header: BlockHeader = {
      hash: '', version: 1, index: height, timestamp: Date.now(),
      previousHash: prev.header.hash, validator: validator.address,
      validatorPubKey: validator.publicKey, validatorSignature: '',
      stateRoot: sHash, txRoot, inferenceTasksRoot: infRoot, computeRoot: compRoot,
    };
    header.hash = hashHeader(header);
    header.validatorSignature = signMessage(header.hash, validator.privateKey);
    const block: Block = { header, transactions: executed };
    this.store.saveBlock(block);
    console.log(`[block] #${height} mined | ${executed.length} txs | ${header.hash.slice(0, 20)}...`);
    return block;
  }

  private matchPendingTasks(height: number): void {
    for (const task of this.store.getTasksByStatus('pending')) {
      for (const node of this.store.getNodes()) {
        if (node.supportedModels.includes(task.targetModel) && node.availableCapacity > 0) {
          const acc = this.store.getAccount(task.requester);
          if (!acc || acc.balance < task.maxFee) continue;
          task.status = 'assigned';
          task.assignedTo = node.nodeId;
          task.collateral = Math.floor(task.maxFee * 0.2);
          this.store.setTask(task);
          acc.balance -= task.maxFee;
          acc.updatedAt = height;
          this.store.setAccount(acc);
          node.availableCapacity--;
          node.activeTasks++;
          this.store.setNode(node);
          console.log(`[match] ${task.taskId.slice(0, 16)} → ${node.nodeId.slice(0, 16)}`);
          break;
        }
      }
    }
  }

  getLatestBlock() { return this.store.getLatestBlock(); }
  getBlockByHeight(h: number) { return this.store.getBlockByHeight(h); }
  getAccount(addr: string) { return this.store.getAccount(addr); }
  getModel(id: string) { return this.store.getModel(id); }
  getTask(id: string) { return this.store.getTask(id); }
  getNode(id: string) { return this.store.getNode(id); }
  getAgent(addr: string) { return this.store.getAgent(addr); }
  getGame(id: string) { return this.store.getGame(id); }
}
