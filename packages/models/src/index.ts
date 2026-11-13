export interface Health {
  status: 'ok';
  timestamp: string;
  /** Whether the AI answer endpoints are configured on this server. */
  ai: boolean;
  /** Whether ElevenLabs is configured: reading aloud (POST /api/speech) and spoken questions (POST /api/transcribe). */
  voice: boolean;
}

/** One step of an exploration: a question the user asked, or a topic they dove into from the map. */
export interface ExplorationStep {
  kind: 'question' | 'dive';
  text: string;
}

/** A saved exploration: every step in order, plus the topic the last page centered on. */
export interface Exploration {
  id: number;
  /** The opening question (same as steps[0].text). */
  question: string;
  focusTitle: string;
  steps: ExplorationStep[];
  createdAt: string;
}

export interface NewExploration {
  focusTitle: string;
  steps: ExplorationStep[];
}

/** An earlier question and its answer, so follow-ups can be understood in context. */
export interface PriorTurn {
  question: string;
  answer: string;
}

export interface AnswerRequest {
  question: string;
  /** Wikipedia titles to answer from, numbered [1], [2], ... in this order. */
  titles: string[];
  history: PriorTurn[];
}

/** Streamed as server-sent events from POST /api/answer. */
export type AnswerEvent =
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface RewriteRequest {
  question: string;
  history: PriorTurn[];
}

export interface RewriteResponse {
  /** A standalone Wikipedia search query for the question. */
  query: string;
}

/** A dated event in a compact brief. `sources` are 1-based excerpt numbers. */
export interface BriefEvent {
  /** For ordering; negative for BCE. */
  year: number;
  /** How the date reads, e.g. "6 December 1917" or "1809". */
  when: string;
  title: string;
  detail: string;
  sources: number[];
}

export interface BriefPoint {
  title: string;
  detail: string;
  sources: number[];
}

/** The compact, visual version of an answer: a headline plus a timeline or key points. */
export interface Brief {
  layout: 'timeline' | 'points';
  headline: string;
  events: BriefEvent[];
  points: BriefPoint[];
}
