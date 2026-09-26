// Fictional AI companies. The Salesforce seed script and the usage generator both
// read this file, so CRM records and usage rows always describe the same accounts.

export type ModelId =
  | "llama-3.3-70b"
  | "qwen3-32b"
  | "deepseek-v3.1"
  | "gpt-oss-120b"
  | "whisper-large-v3"
  | "flux-1-dev"
  | "bge-m3"
  | "orpheus-tts";

type ModelProfile = {
  usdPer1kRequests: number;
  usdPerGpuHour: number;
  p95LatencyMs: number;
  errorRate: number;
};

export const MODELS: Record<ModelId, ModelProfile> = {
  "llama-3.3-70b": { usdPer1kRequests: 1.2, usdPerGpuHour: 6.5, p95LatencyMs: 950, errorRate: 0.004 },
  "qwen3-32b": { usdPer1kRequests: 0.6, usdPerGpuHour: 4.0, p95LatencyMs: 700, errorRate: 0.003 },
  "deepseek-v3.1": { usdPer1kRequests: 2.1, usdPerGpuHour: 9.0, p95LatencyMs: 1600, errorRate: 0.005 },
  "gpt-oss-120b": { usdPer1kRequests: 1.5, usdPerGpuHour: 7.5, p95LatencyMs: 1200, errorRate: 0.004 },
  "whisper-large-v3": { usdPer1kRequests: 0.35, usdPerGpuHour: 3.0, p95LatencyMs: 2200, errorRate: 0.002 },
  "flux-1-dev": { usdPer1kRequests: 8.0, usdPerGpuHour: 5.5, p95LatencyMs: 4200, errorRate: 0.006 },
  "bge-m3": { usdPer1kRequests: 0.05, usdPerGpuHour: 2.5, p95LatencyMs: 120, errorRate: 0.001 },
  "orpheus-tts": { usdPer1kRequests: 1.0, usdPerGpuHour: 4.5, p95LatencyMs: 800, errorRate: 0.003 },
};

export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

export type Plan = "Pay as you go" | "Committed";

export type SeedContact = { firstName: string; lastName: string; title: string };

export type SeedOpportunity = { name: string; stage: string; amount: number; closeDate: string };

export type SeedAccount = {
  key: string;
  name: string;
  industry: string;
  description: string;
  plan: Plan;
  /** Typical weekday spend in USD; weekends run at 80%. */
  dailySpend: number;
  /** Share of spend per model; sums to 1. */
  mix: Partial<Record<ModelId, number>>;
  /** Committed accounts only: annual commit as a multiple of their normal annual run rate. */
  commitFactor?: number;
  renewalDate?: string;
  openOpportunity?: SeedOpportunity;
  /** The first contact is the primary one. */
  contacts: SeedContact[];
};

/** A normal week: 5 weekdays plus 2 weekend days at 80%. */
export const WEEKDAYS_EQUIVALENT_PER_WEEK = 5 + 2 * 0.8;

/** Annual commit, rounded to $10k, sized so a normal week never trips the commit-pace rule. */
export function committedSpend(account: SeedAccount): number | null {
  if (account.plan !== "Committed" || !account.commitFactor) return null;
  const annualRunRate = account.dailySpend * WEEKDAYS_EQUIVALENT_PER_WEEK * 52;
  return Math.round((annualRunRate * account.commitFactor) / 10_000) * 10_000;
}

export function contactEmail(account: SeedAccount, contact: SeedContact): string {
  const domain = account.key.replace(/^acct_/, "").replace(/_/g, "");
  return `${contact.firstName}.${contact.lastName}@${domain}.example`.toLowerCase();
}

export const ACCOUNTS: SeedAccount[] = [
  {
    key: "acct_lumenforge", name: "Lumenforge", industry: "Media", description: "AI video generation for marketing teams",
    plan: "Committed", dailySpend: 6000, mix: { "flux-1-dev": 0.7, "qwen3-32b": 0.3 }, commitFactor: 1.05, renewalDate: "2027-03-15",
    openOpportunity: { name: "Lumenforge - FY27 commit expansion", stage: "Proposal/Price Quote", amount: 600000, closeDate: "2026-11-20" },
    contacts: [{ firstName: "Maya", lastName: "Okafor", title: "VP Engineering" }, { firstName: "Tom", lastName: "Reyes", title: "Head of ML Platform" }],
  },
  {
    key: "acct_parsewell", name: "Parsewell", industry: "Insurance", description: "Document extraction for insurance claims",
    plan: "Committed", dailySpend: 2500, mix: { "llama-3.3-70b": 0.6, "bge-m3": 0.4 }, commitFactor: 1.1, renewalDate: "2026-12-01",
    contacts: [{ firstName: "Priya", lastName: "Nandakumar", title: "CTO" }],
  },
  {
    key: "acct_quillmark", name: "Quillmark Legal", industry: "Legal", description: "Contract drafting copilot",
    plan: "Committed", dailySpend: 1800, mix: { "deepseek-v3.1": 0.8, "bge-m3": 0.2 }, commitFactor: 1.02, renewalDate: "2027-06-30",
    openOpportunity: { name: "Quillmark - Dedicated deployment", stage: "Qualification", amount: 250000, closeDate: "2026-12-15" },
    contacts: [{ firstName: "Daniel", lastName: "Hart", title: "Director of Engineering" }, { firstName: "Ines", lastName: "Varga", title: "Procurement Lead" }],
  },
  {
    key: "acct_scribewell", name: "Scribewell Health", industry: "Healthcare", description: "Ambient clinical note taking",
    plan: "Committed", dailySpend: 4200, mix: { "whisper-large-v3": 0.6, "llama-3.3-70b": 0.4 }, commitFactor: 1.08, renewalDate: "2027-01-31",
    contacts: [{ firstName: "Grace", lastName: "Liang", title: "VP Product" }],
  },
  {
    key: "acct_vantaloop", name: "Vantaloop", industry: "Sales Tech", description: "Sales call summaries and coaching",
    plan: "Pay as you go", dailySpend: 900, mix: { "whisper-large-v3": 0.5, "qwen3-32b": 0.5 },
    openOpportunity: { name: "Vantaloop - Committed plan", stage: "Needs Analysis", amount: 150000, closeDate: "2026-11-30" },
    contacts: [{ firstName: "Omar", lastName: "Haddad", title: "Co-founder and CTO" }],
  },
  {
    key: "acct_driftwood", name: "Driftwood Robotics", industry: "Logistics", description: "Vision models for warehouse robots",
    plan: "Pay as you go", dailySpend: 600, mix: { "qwen3-32b": 1 },
    contacts: [{ firstName: "Lena", lastName: "Brandt", title: "Head of Perception" }, { firstName: "Sam", lastName: "Oduya", title: "Engineering Manager" }],
  },
  {
    key: "acct_kestrelcode", name: "Kestrel Code", industry: "Developer Tools", description: "AI coding assistant",
    plan: "Committed", dailySpend: 8500, mix: { "gpt-oss-120b": 0.5, "deepseek-v3.1": 0.5 }, commitFactor: 1.0, renewalDate: "2027-02-28",
    openOpportunity: { name: "Kestrel Code - Renewal and expansion", stage: "Negotiation/Review", amount: 1200000, closeDate: "2027-01-31" },
    contacts: [{ firstName: "Aiden", lastName: "Mercer", title: "VP Infrastructure" }, { firstName: "Rosa", lastName: "Estrada", title: "Finance Director" }],
  },
  {
    key: "acct_northpaw", name: "Northpaw Support", industry: "Customer Service", description: "Autonomous customer support agent",
    plan: "Committed", dailySpend: 3100, mix: { "llama-3.3-70b": 0.7, "bge-m3": 0.3 }, commitFactor: 1.12, renewalDate: "2026-11-15",
    contacts: [{ firstName: "Hannah", lastName: "Kowalski", title: "CTO" }],
  },
  {
    key: "acct_glimmerlab", name: "Glimmerlab", industry: "E-commerce", description: "Product photography generation",
    plan: "Pay as you go", dailySpend: 1400, mix: { "flux-1-dev": 1 },
    contacts: [{ firstName: "Jonah", lastName: "Price", title: "Founding Engineer" }],
  },
  {
    key: "acct_tidewire", name: "Tidewire Voice", industry: "Contact Center", description: "Voice agents for call centers",
    plan: "Committed", dailySpend: 2200, mix: { "whisper-large-v3": 0.4, "orpheus-tts": 0.3, "qwen3-32b": 0.3 }, commitFactor: 1.06, renewalDate: "2027-04-30",
    openOpportunity: { name: "Tidewire - Multi-region rollout", stage: "Value Proposition", amount: 300000, closeDate: "2027-02-15" },
    contacts: [{ firstName: "Chloe", lastName: "Dubois", title: "VP Engineering" }, { firstName: "Marcus", lastName: "Webb", title: "Solutions Architect" }],
  },
  {
    key: "acct_orchardly", name: "Orchardly", industry: "Agriculture", description: "Agronomy advisor for farm co-ops",
    plan: "Pay as you go", dailySpend: 250, mix: { "qwen3-32b": 1 },
    contacts: [{ firstName: "Ruth", lastName: "Jensen", title: "Head of Product" }],
  },
  {
    key: "acct_fernquist", name: "Fernquist Search", industry: "Enterprise Software", description: "Enterprise search over internal docs",
    plan: "Committed", dailySpend: 1500, mix: { "bge-m3": 0.5, "llama-3.3-70b": 0.5 }, commitFactor: 1.04, renewalDate: "2027-08-31",
    contacts: [{ firstName: "Victor", lastName: "Almeida", title: "Engineering Director" }],
  },
  {
    key: "acct_mosaicly", name: "Mosaicly", industry: "Productivity", description: "AI-generated presentations",
    plan: "Pay as you go", dailySpend: 1100, mix: { "gpt-oss-120b": 0.6, "flux-1-dev": 0.4 },
    openOpportunity: { name: "Mosaicly - Committed plan", stage: "Proposal/Price Quote", amount: 200000, closeDate: "2026-12-10" },
    contacts: [{ firstName: "Nora", lastName: "Fitzgerald", title: "CEO" }, { firstName: "Kenji", lastName: "Watanabe", title: "Staff Engineer" }],
  },
  {
    key: "acct_halcyon", name: "Halcyon Tutor", industry: "Education", description: "One-on-one AI tutoring",
    plan: "Pay as you go", dailySpend: 700, mix: { "llama-3.3-70b": 1 },
    contacts: [{ firstName: "Elena", lastName: "Petrova", title: "CTO" }],
  },
  {
    key: "acct_ironbark", name: "Ironbark Security", industry: "Cybersecurity", description: "Security alert triage",
    plan: "Committed", dailySpend: 2800, mix: { "deepseek-v3.1": 0.6, "gpt-oss-120b": 0.4 }, commitFactor: 1.09, renewalDate: "2027-05-31",
    openOpportunity: { name: "Ironbark - SOC copilot expansion", stage: "Qualification", amount: 350000, closeDate: "2027-01-15" },
    contacts: [{ firstName: "Felix", lastName: "Wagner", title: "VP Engineering" }],
  },
  {
    key: "acct_plumline", name: "Plumline Research", industry: "Financial Services", description: "Equity research assistant",
    plan: "Committed", dailySpend: 3600, mix: { "deepseek-v3.1": 0.7, "bge-m3": 0.3 }, commitFactor: 1.03, renewalDate: "2026-12-20",
    contacts: [{ firstName: "Amara", lastName: "Nwosu", title: "Head of AI" }, { firstName: "Luke", lastName: "Bennett", title: "Procurement Manager" }],
  },
  {
    key: "acct_cobaltcart", name: "Cobaltcart", industry: "Retail", description: "Personalized product recommendations",
    plan: "Pay as you go", dailySpend: 450, mix: { "bge-m3": 0.6, "qwen3-32b": 0.4 },
    openOpportunity: { name: "Cobaltcart - Holiday capacity", stage: "Needs Analysis", amount: 80000, closeDate: "2026-11-05" },
    contacts: [{ firstName: "Isla", lastName: "Morrison", title: "Engineering Lead" }],
  },
  {
    key: "acct_wrenfield", name: "Wrenfield Translate", industry: "Localization", description: "Real-time translation",
    plan: "Pay as you go", dailySpend: 800, mix: { "llama-3.3-70b": 0.5, "qwen3-32b": 0.5 },
    contacts: [{ firstName: "Mateo", lastName: "Rossi", title: "CTO" }],
  },
  {
    key: "acct_saltmarsh", name: "Saltmarsh Bio", industry: "Biotech", description: "Protein design research assistant",
    plan: "Committed", dailySpend: 1200, mix: { "gpt-oss-120b": 1 }, commitFactor: 1.07, renewalDate: "2027-09-15",
    openOpportunity: { name: "Saltmarsh - Private cluster", stage: "Value Proposition", amount: 180000, closeDate: "2027-03-01" },
    contacts: [{ firstName: "Julia", lastName: "Carvalho", title: "Head of Computational Biology" }, { firstName: "Ben", lastName: "Adler", title: "IT Director" }],
  },
  {
    key: "acct_pinecrest", name: "Pinecrest Talent", industry: "HR Tech", description: "Resume screening and interview notes",
    plan: "Pay as you go", dailySpend: 350, mix: { "qwen3-32b": 0.7, "bge-m3": 0.3 },
    contacts: [{ firstName: "Tessa", lastName: "Quinn", title: "Head of Engineering" }],
  },
  {
    key: "acct_emberly", name: "Emberly Games", industry: "Gaming", description: "Dynamic NPC dialogue",
    plan: "Pay as you go", dailySpend: 1900, mix: { "llama-3.3-70b": 0.6, "orpheus-tts": 0.4 },
    openOpportunity: { name: "Emberly - Launch capacity reservation", stage: "Negotiation/Review", amount: 250000, closeDate: "2026-10-31" },
    contacts: [{ firstName: "Kai", lastName: "Andersen", title: "Technical Director" }, { firstName: "Zoe", lastName: "Hamilton", title: "Producer" }],
  },
  {
    key: "acct_quarrystone", name: "Quarrystone Analytics", industry: "Business Intelligence", description: "Natural-language BI copilot",
    plan: "Committed", dailySpend: 2000, mix: { "gpt-oss-120b": 0.7, "qwen3-32b": 0.3 }, commitFactor: 1.05, renewalDate: "2027-07-31",
    contacts: [{ firstName: "Adrian", lastName: "Cole", title: "VP Data" }],
  },
  {
    key: "acct_marigold", name: "Marigold Meet", industry: "Productivity", description: "Meeting notes and action items",
    plan: "Pay as you go", dailySpend: 1000, mix: { "whisper-large-v3": 0.7, "llama-3.3-70b": 0.3 },
    contacts: [{ firstName: "Sofia", lastName: "Lindqvist", title: "CTO" }, { firstName: "Eli", lastName: "Turner", title: "Platform Engineer" }],
  },
  {
    key: "acct_lanternfish", name: "Lanternfish Audio", industry: "Media", description: "Podcast editing and dubbing",
    plan: "Pay as you go", dailySpend: 550, mix: { "whisper-large-v3": 0.6, "orpheus-tts": 0.4 },
    openOpportunity: { name: "Lanternfish - Committed plan", stage: "Qualification", amount: 90000, closeDate: "2026-12-31" },
    contacts: [{ firstName: "Ivy", lastName: "Chen", title: "Co-founder" }],
  },
  {
    key: "acct_thistledown", name: "Thistledown Travel", industry: "Travel", description: "Travel concierge agent",
    plan: "Pay as you go", dailySpend: 300, mix: { "llama-3.3-70b": 1 },
    contacts: [{ firstName: "Noah", lastName: "Fischer", title: "Head of Engineering" }],
  },
];
