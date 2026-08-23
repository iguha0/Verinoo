import { Command } from 'commander';
import { AINativeNode } from '../node';

const program = new Command();

program.name('ainative').description('AI-Native Blockchain Node').version('0.1.0');

program.command('start')
  .option('--name <name>', 'node name', 'node' + Math.floor(Math.random()*10000))
  .option('--db <dir>', 'data directory', './data/node')
  .option('--port <port>', 'API port', '3001')
  .option('--p2p <port>', 'P2P port', '5001')
  .option('--host <host>', 'host', '0.0.0.0')
  .option('--peers <list>', 'comma-separated peer URLs')
  .option('--validator', 'produce blocks', false)
  .action(async (opts) => {
    const node = new AINativeNode({
      name: opts.name,
      dataDir: opts.db,
      p2pHost: opts.host,
      p2pPort: parseInt(opts.p2p),
      apiPort: parseInt(opts.port),
      peers: opts.peers ? opts.peers.split(',').filter(Boolean) : [],
      validator: !!opts.validator,
    });
    process.on('SIGINT', () => { console.log('\nShutting down...'); node.stop(); process.exit(0); });
    await node.start();
  });

program.command('keygen')
  .option('--output <file>', 'output', 'key.json')
  .action((opts) => {
    const { generateKeyPair } = require('../wallet/crypto');
    const fs = require('fs');
    const kp = generateKeyPair();
    fs.writeFileSync(opts.output, JSON.stringify(kp, null, 2));
    console.log('Keypair:', kp.address);
  });

if (require.main === module) program.parse();
