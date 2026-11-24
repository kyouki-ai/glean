// Env lookup with back-compat: SKIM_* first, then the legacy GLEAN_* name.
export const env = (name) => process.env[name] ?? process.env[name.replace(/^SKIM_/, 'GLEAN_')];
