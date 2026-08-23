// === Core types for AI-Native Blockchain ===

export type Hash = string;
export type Address = string;
export type Signature = string;

export interface KeyPair {
  publicKey: string;
  privateKey: string;
  address: Address;
}

export interface BlockHeader {
  hash: Hash;
  version: number;
  index: number;
  timestamp: number;
  previousHash: Hash;
  validator: Address;
  validatorPubKey: string;
  validatorSignature: Signature;
  stateRoot: Hash;
  txRoot: Hash;
  inferenceTasksRoot: Hash;
  computeRoot: Hash;
}

export interface Block {
  header: BlockHeader;
  transactions: Transaction[];
}

export interface Transaction {
  txId: Hash;
  from: Address;
  to: Address;
  value: number;
  nonce: number;
  gasPrice?: number;
  gasLimit?: number;
  data: TransactionData;
  signature: Signature;
  publicKey: string;
}

export interface TransactionData {
  type: string;
  data: unknown;
}

export interface ModelRegistryEntry {
  modelId: Hash;
  owner: Address;
  architecture: string;
  parameterCount: number;
  weightsHash: Hash;
  runtimeHash: Hash;
  stakingRequirement: number;
  registeredAt: number;
  isActive: boolean;
  metadata?: Record<string, unknown>;
}

export interface InferenceTask {
  taskId: Hash;
  requester: Address;
  targetModel: Hash;
  inputCommitment: Hash;
  maxFee: number;
  deadline: number;
  status: string;
  resultHash?: Hash;
  resultOutput?: string;
  assignedTo?: Address;
  verificationType: string;
  collateral?: number;
  proofData?: string;
  // Verification game
  gameId?: Hash;           // set when challenged
  challengeWindowEnd?: number; // block height when challenge period closes
}

export interface ComputeNode {
  nodeId: Address;
  publicKey: string;
  stakedAmount: number;
  totalSlashed: number;
  availableCapacity: number;
  maxCapacity: number;
  activeTasks: number;
  reputation: number;
  successfulInferences: number;
  failedInferences: number;
  supportedModels: Hash[];
  lastHeartbeatAt: number;
  registeredAt: number;
  isActive: boolean;
}

export interface AgentAccount {
  address: Address;
  publicKey: string;
  nonce: number;
  balance: number;
  reputation: number;
  totalInferences: number;
  totalFeesPaid: number;
  isAutonomous: boolean;
  servicesProvided: Record<string, number>;
  updatedAt: number;
}

export interface AccountState {
  address: Address;
  publicKey: string;
  nonce: number;
  balance: number;
  updatedAt: number;
}

// --- Verification Game (Bisection Protocol) ---

export interface VerificationGame {
  gameId: Hash;
  taskId: Hash;
  challenger: Address;
  defender: Address;
  status: 'open' | 'bisecting' | 'proving' | 'resolved_valid' | 'resolved_slash';
  // Bisection state
  low: number;                    // lower bound layer index (initially 0)
  high: number;                  // upper bound layer index (model layer count)
  currentStep: number;           // current bisection step number
  maxSteps: number;               // ceil(log2(layers)) for timeout
  // Layer commitments: each player commits to Merkle root of their trace up to each layer
  challengerCommitments: Record<number, Hash>;  // layerIndex -> traceRoot
  defenderCommitments: Record<number, Hash>;  // layerIndex -> traceRoot
  // Final step
  disputedLayer: number;          // the exact layer where they disagree
  challengerBond: number;         // stake locked
  defenderBond: number;           // additional stake from task collateral
  winner?: Address;
  loser?: Address;
  openedAt: number;              // block height
  resolvedAt?: number;
  // Timeout tracking
  lastMoveAt: number;             // block height of last action
  moveTimeout: number;            // blocks before auto-forfeit (5 blocks)
  // Deterministic spec: fixed per architecture
  architecture: string;            // e.g., "Gemma-2B-IT" or "Phi-2-Medical-v1"
  layerSpec: LayerSpec[];          // what each layer means for this architecture
}

export interface LayerSpec {
  index: number;
  name: string;                    // e.g., "embedding", "attn_0", "ffn_0", "head_norm"
  opType: 'embedding' | 'attention' | 'ffn' | 'layernorm' | 'head' | 'relu';
  inputShape: number[];             // for trace validation
  outputShape: number[];            // for trace validation
  tolerance: number;                // allowed cosine distance for "match" (e.g., 0.001)
}

export interface HeartbeatPayload {
  nodeId: string;
  timestamp: number;
  blockHeight: number;
  activeTasks: number;
  availableCapacity: number;
  headHash: string;
}
