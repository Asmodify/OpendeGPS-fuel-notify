// Entry point: node --no-warnings src/server.js
// node:sqlite is still flagged "experimental" in Node 24; hide that one warning even when
// started without --no-warnings, then load the app.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w?.name === 'ExperimentalWarning') return;
  console.warn(`${w?.name || 'Warning'}: ${w?.message || w}`);
});

await import('./main.js');
