const STORAGE_KEY = "eng_kg_recent_questions";
const MAX_STORED = 50;

export interface RecentQuestion {
  id: string;
  question: string;
  timestamp: number;
}

export function getRecentQuestions(): RecentQuestion[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as RecentQuestion[];
  } catch {
    return [];
  }
}

export function saveRecentQuestion(question: string): void {
  try {
    const existing = getRecentQuestions();
    const entry: RecentQuestion = {
      id: crypto.randomUUID(),
      question,
      timestamp: Date.now(),
    };
    const updated = [entry, ...existing].slice(0, MAX_STORED);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  } catch {
    // ignore storage errors
  }
}

export function countQuestionsThisWeek(): number {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return getRecentQuestions().filter((q) => q.timestamp > oneWeekAgo).length;
}
