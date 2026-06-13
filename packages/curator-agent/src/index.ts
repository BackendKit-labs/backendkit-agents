export { CuratorAgent }                          from './agent.js';
export { CuratorClient }                         from './client.js';
export { VaultMemory }                           from './memory/vault-memory.js';
export { createCuratorTools }                    from './tools/index.js';
export { PROFILES, CURATOR_PROFILE,
         QUALITY_CHECKER_PROFILE, TAGGER_PROFILE } from './agents/profiles.js';
export { KnowledgeCurator }                      from './curator.js';
export type { CuratorAgentOptions, ProcessResult } from './agent.js';
export type { ProcessResult as CuratorResult }   from './client.js';
export type { NoteEntry }                        from './memory/vault-memory.js';
export type { CurationResult, CuratedNote }      from './types.js';
