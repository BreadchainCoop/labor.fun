import { ContainerInput } from '../runtime.js';

/**
 * Arguments to a single query turn. The backend should run the agent loop,
 * stream `result` envelopes via the shared writeOutput helper, and return
 * session-tracking info for the outer turn loop in index.ts.
 */
export interface RunQueryArgs {
  prompt: string;
  sessionId: string | undefined;
  resumeAt: string | undefined;
  mcpServerPath: string;
  containerInput: ContainerInput;
  sdkEnv: Record<string, string | undefined>;
  hasGoogleWorkspace: boolean;
  hasGithub: boolean;
  hasLinear: boolean;
}

export interface RunQueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
}

export interface Backend {
  /**
   * Process a single user turn (with possible follow-up IPC messages piped in mid-turn).
   * Returns when the model has finished and is waiting for the next user message,
   * or when the _close sentinel was consumed mid-turn.
   */
  runQuery(args: RunQueryArgs): Promise<RunQueryResult>;
}
