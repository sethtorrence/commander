// PROTOTYPE: stands in for Ares's background process (Electron utilityProcess).
let beats = 0;
setInterval(() => { beats++; process.parentPort.postMessage({ type: 'beat', beats, at: Date.now() }); }, 1000);
