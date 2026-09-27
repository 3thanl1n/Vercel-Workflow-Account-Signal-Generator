import { deleteTokenCacheEntry, getConnectorMetadata } from "@vercel/connect";
import { connectToken } from "@/lib/connect";
import { FatalError, RetryableError } from "workflow";
import type { CrmAccount } from "@/lib/rules";

// Salesforce access. Default: Vercel Connect's JWT bearer flow. Vercel signs an assertion
// naming the integration user (SALESFORCE_USERNAME) with a key it keeps, and Salesforce
// returns a short-lived token for that user. No one has to be logged in (the daily cron),
// and no Salesforce secret lives in env vars. The user must be pre-authorized on the
// External Client App in Salesforce Setup.
// Fallback: an External Client App's client-credentials flow, used only when
// SALESFORCE_CLIENT_ID is set.

export const SALESFORCE_CONNECTOR = process.env.SALESFORCE_CONNECTOR ?? "salesforce/signal-gen-sf";
export const SF_API_VERSION = "v66.0";

function connectParams() {
  const username = process.env.SALESFORCE_USERNAME;
  if (!username) throw new FatalError("SALESFORCE_USERNAME is not set (the Salesforce user the integration runs as).");
  return { subject: { type: "jwt-bearer" as const, sub: username } };
}

type Session = { accessToken: string; instanceUrl: string };

export async function getSalesforceSession(): Promise<Session> {
  if (process.env.SALESFORCE_CLIENT_ID) return clientCredentialsSession();

  const response = await connectToken(SALESFORCE_CONNECTOR, connectParams());
  const instanceUrl =
    pickUrl(response.metadata, ["instance_url", "instanceUrl"]) ??
    pickUrl(response.claims, ["instance_url", "instanceUrl"]) ??
    process.env.SALESFORCE_INSTANCE_URL ??
    (await getConnectorMetadata(SALESFORCE_CONNECTOR)).clientUrl;
  if (!instanceUrl) throw new FatalError("Salesforce instance URL not found; set SALESFORCE_INSTANCE_URL.");
  return { accessToken: response.token, instanceUrl: instanceUrl.replace(/\/$/, "") };
}

async function clientCredentialsSession(): Promise<Session> {
  const loginUrl = process.env.SALESFORCE_LOGIN_URL;
  if (!loginUrl) throw new FatalError("SALESFORCE_LOGIN_URL is not set (your My Domain URL).");
  const res = await fetch(`${loginUrl.replace(/\/$/, "")}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SALESFORCE_CLIENT_ID!,
      client_secret: process.env.SALESFORCE_CLIENT_SECRET ?? "",
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new FatalError(`Salesforce login failed: ${body.error_description ?? res.status}`);
  return { accessToken: body.access_token, instanceUrl: body.instance_url };
}

function pickUrl(source: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === "string" && value.startsWith("https://")) return value;
  }
  return undefined;
}

/**
 * Calls the Salesforce REST API. Auth and bad-request errors won't fix themselves,
 * so they stop the step (FatalError); rate limits and server errors are retried.
 */
export async function sfFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const { accessToken, instanceUrl } = await getSalesforceSession();
    const url = path.startsWith("/services/") ? `${instanceUrl}${path}` : `${instanceUrl}/services/data/${SF_API_VERSION}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", ...init.headers },
    });

    if (res.status === 401 && attempt === 1 && !process.env.SALESFORCE_CLIENT_ID) {
      // Token revoked or expired early: drop the cached one and try once more.
      deleteTokenCacheEntry(SALESFORCE_CONNECTOR, connectParams());
      continue;
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : undefined) as T;

    const message = `Salesforce ${init.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 500)}`;
    if (res.status === 429 || res.status >= 500) throw new RetryableError(message, { retryAfter: "30s" });
    throw new FatalError(message);
  }
}

type QueryPage<T> = { records: T[]; done: boolean; nextRecordsUrl?: string };

/** Runs a SOQL query and follows pagination. Pass tooling=true for the Tooling API. */
export async function sfQuery<T>(soql: string, tooling = false): Promise<T[]> {
  const records: T[] = [];
  let page = await sfFetch<QueryPage<T>>(`${tooling ? "/tooling" : ""}/query?q=${encodeURIComponent(soql)}`);
  records.push(...page.records);
  while (!page.done && page.nextRecordsUrl) {
    page = await sfFetch<QueryPage<T>>(page.nextRecordsUrl);
    records.push(...page.records);
  }
  return records;
}

type AccountRecord = {
  Id: string;
  Name: string;
  Owner: { Name: string } | null;
  Plan__c: "Pay as you go" | "Committed" | null;
  Committed_Spend__c: number | null;
  Renewal_Date__c: string | null;
  Usage_Account_Key__c: string;
  Opportunities: { totalSize: number } | null;
};

/** Every Signal Gen account with the fields the rules need. */
export async function loadCrmAccounts(): Promise<CrmAccount[]> {
  const records = await sfQuery<AccountRecord>(
    `SELECT Id, Name, Owner.Name, Plan__c, Committed_Spend__c, Renewal_Date__c, Usage_Account_Key__c,
       (SELECT Id FROM Opportunities WHERE IsClosed = false LIMIT 1)
     FROM Account WHERE Usage_Account_Key__c != null ORDER BY Name`,
  );
  return records.map((r) => ({
    accountKey: r.Usage_Account_Key__c,
    salesforceId: r.Id,
    name: r.Name,
    ownerName: r.Owner?.Name ?? null,
    plan: r.Plan__c,
    committedSpend: r.Committed_Spend__c,
    renewalDate: r.Renewal_Date__c,
    hasOpenOpportunity: (r.Opportunities?.totalSize ?? 0) > 0,
  }));
}

export type AccountDetails = {
  name: string;
  owner: string | null;
  plan: string | null;
  committedSpend: number | null;
  renewalDate: string | null;
  description: string | null;
  contacts: { name: string; title: string | null; email: string | null; primary: boolean }[];
  openOpportunities: { name: string; stage: string; amount: number | null; closeDate: string }[];
};

type AccountDetailRecord = {
  Name: string;
  Owner: { Name: string } | null;
  Plan__c: string | null;
  Committed_Spend__c: number | null;
  Renewal_Date__c: string | null;
  Description: string | null;
  Contacts: { records: { Name: string; Title: string | null; Email: string | null; Primary_Contact__c: boolean }[] } | null;
  Opportunities: { records: { Name: string; StageName: string; Amount: number | null; CloseDate: string }[] } | null;
};

/** One account's CRM picture for the agent (read-only). The primary contact comes first. */
export async function loadAccountDetails(accountKey: string): Promise<AccountDetails> {
  const [r] = await sfQuery<AccountDetailRecord>(
    `SELECT Name, Owner.Name, Plan__c, Committed_Spend__c, Renewal_Date__c, Description,
       (SELECT Name, Title, Email, Primary_Contact__c FROM Contacts ORDER BY Primary_Contact__c DESC, Name),
       (SELECT Name, StageName, Amount, CloseDate FROM Opportunities WHERE IsClosed = false)
     FROM Account WHERE Usage_Account_Key__c = '${accountKey.replace(/[^\w-]/g, "")}'`,
  );
  if (!r) throw new FatalError(`No Salesforce account with Usage_Account_Key__c = ${accountKey}`);
  return {
    name: r.Name,
    owner: r.Owner?.Name ?? null,
    plan: r.Plan__c,
    committedSpend: r.Committed_Spend__c,
    renewalDate: r.Renewal_Date__c,
    description: r.Description,
    contacts: (r.Contacts?.records ?? []).map((c) => ({ name: c.Name, title: c.Title, email: c.Email, primary: c.Primary_Contact__c })),
    openOpportunities: (r.Opportunities?.records ?? []).map((o) => ({
      name: o.Name,
      stage: o.StageName,
      amount: o.Amount,
      closeDate: o.CloseDate,
    })),
  };
}
