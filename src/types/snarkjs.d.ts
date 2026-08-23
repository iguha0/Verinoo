declare module 'snarkjs' {
  export const groth16: {
    fullProve: (input: any, wasmFile: string, zkeyFile: string) => Promise<{ proof: any; publicSignals: string[] }>;
    verify: (vkey: any, publicSignals: string[], proof: any) => Promise<boolean>;
  };
  export const wtns: {
    calculate: (input: any, wasmFile: string, outputFile: string) => Promise<void>;
  };
}
