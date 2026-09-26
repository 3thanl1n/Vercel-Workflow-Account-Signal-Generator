// Sets up the Salesforce Developer Edition org for Signal Gen. Safe to rerun:
//  1. creates the 4 custom Account fields if missing (Tooling API)
//  2. grants your profile read/edit on them (new fields are hidden from the API otherwise)
//  3. upserts ~25 fictional accounts by Usage_Account_Key__c (external ID)
//  4. creates or updates their contacts (matched by email) and open opportunities (matched by name)
import { ACCOUNTS, committedSpend, contactEmail } from "@/data/accounts";
import { SF_API_VERSION, getSalesforceSession, loadCrmAccounts, sfFetch, sfQuery } from "@/lib/salesforce";

const NOTE = "Managed by the Signal Gen seed script.";

const FIELDS = [
  {
    FullName: "Account.Plan__c",
    Metadata: {
      label: "Plan",
      type: "Picklist",
      description: NOTE,
      valueSet: {
        restricted: true,
        valueSetDefinition: {
          sorted: false,
          value: ["Pay as you go", "Committed"].map((v) => ({ fullName: v, label: v, default: false })),
        },
      },
    },
  },
  { FullName: "Account.Committed_Spend__c", Metadata: { label: "Committed Spend", type: "Currency", precision: 18, scale: 2, description: NOTE } },
  { FullName: "Account.Renewal_Date__c", Metadata: { label: "Renewal Date", type: "Date", description: NOTE } },
  {
    FullName: "Account.Usage_Account_Key__c",
    Metadata: { label: "Usage Account Key", type: "Text", length: 64, externalId: true, unique: true, caseSensitive: false, description: NOTE },
  },
];

type SaveResult = { id: string; success: boolean; created?: boolean; errors: { message: string }[] };

const quote = (value: string) => `'${value.replace(/'/g, "\\'")}'`;

function checkResults(label: string, results: SaveResult[]) {
  const failed = results.filter((r) => !r.success);
  if (failed.length) throw new Error(`${label}: ${failed.map((r) => r.errors.map((e) => e.message).join("; ")).join(" | ")}`);
}

async function saveCollection(type: string, records: Record<string, unknown>[]) {
  const creates = records.filter((r) => !r.Id);
  const updates = records.filter((r) => r.Id);
  for (const [method, batch] of [["POST", creates], ["PATCH", updates]] as const) {
    if (batch.length === 0) continue;
    const results = await sfFetch<SaveResult[]>("/composite/sobjects", {
      method,
      body: JSON.stringify({ allOrNone: true, records: batch.map((r) => ({ attributes: { type }, ...r })) }),
    });
    checkResults(`${type} ${method}`, results);
  }
  return { created: creates.length, updated: updates.length };
}

// 1. Connection check
const session = await getSalesforceSession();
const me = await sfFetch<{ preferred_username: string; user_id: string; organization_id: string }>("/services/oauth2/userinfo");
const versions = await sfFetch<{ version: string }[]>("/services/data/");
const latest = `v${versions.at(-1)!.version}`;
console.log(`Connected to ${session.instanceUrl} as ${me.preferred_username} (org ${me.organization_id}).`);
console.log(`API: using ${SF_API_VERSION}, org supports up to ${latest}.`);

// Safety: this script adds fields and fake data, so only run it against a Developer Edition
// org unless explicitly told otherwise.
const [org] = await sfQuery<{ Name: string; OrganizationType: string; IsSandbox: boolean }>(
  "SELECT Name, OrganizationType, IsSandbox FROM Organization",
);
console.log(`Org: ${org.Name} (${org.OrganizationType}${org.IsSandbox ? ", sandbox" : ""}).`);
if (org.OrganizationType !== "Developer Edition" && !process.argv.includes("--allow-non-developer-org")) {
  throw new Error(
    `Refusing to seed a ${org.OrganizationType} org. Rerun with --allow-non-developer-org if this org is really a demo org.`,
  );
}

// 2. Custom fields
const existing = new Set(
  (await sfQuery<{ DeveloperName: string }>(`SELECT DeveloperName FROM CustomField WHERE TableEnumOrId = 'Account'`, true)).map(
    (f) => `Account.${f.DeveloperName}__c`,
  ),
);
for (const field of FIELDS) {
  if (existing.has(field.FullName)) continue;
  await sfFetch("/tooling/sobjects/CustomField", { method: "POST", body: JSON.stringify(field) });
  console.log(`Created field ${field.FullName}`);
}

// 3. Field access for the connected user's profile
const [user] = await sfQuery<{ ProfileId: string; Profile: { Name: string } }>(
  `SELECT ProfileId, Profile.Name FROM User WHERE Id = ${quote(me.user_id)}`,
);
const [permissionSet] = await sfQuery<{ Id: string }>(
  `SELECT Id FROM PermissionSet WHERE IsOwnedByProfile = true AND ProfileId = ${quote(user.ProfileId)}`,
);
const grants = await sfQuery<{ Id: string; Field: string; PermissionsRead: boolean; PermissionsEdit: boolean }>(
  `SELECT Id, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions
   WHERE ParentId = ${quote(permissionSet.Id)} AND SobjectType = 'Account'
   AND Field IN (${FIELDS.map((f) => quote(f.FullName)).join(", ")})`,
);
const fieldAccess = await saveCollection(
  "FieldPermissions",
  FIELDS.map((f) => grants.find((g) => g.Field === f.FullName))
    .map((grant, i) =>
      grant
        ? grant.PermissionsRead && grant.PermissionsEdit
          ? null
          : { Id: grant.Id, PermissionsRead: true, PermissionsEdit: true }
        : { ParentId: permissionSet.Id, SobjectType: "Account", Field: FIELDS[i].FullName, PermissionsRead: true, PermissionsEdit: true },
    )
    .filter((r): r is NonNullable<typeof r> => r !== null),
);
console.log(`Field access for profile "${user.Profile.Name}": ${fieldAccess.created} granted, ${fieldAccess.updated} fixed.`);

// 4. Accounts (upsert on the external ID)
const accountResults = await sfFetch<SaveResult[]>("/composite/sobjects/Account/Usage_Account_Key__c", {
  method: "PATCH",
  body: JSON.stringify({
    allOrNone: true,
    records: ACCOUNTS.map((a) => ({
      attributes: { type: "Account" },
      Usage_Account_Key__c: a.key,
      Name: a.name,
      Description: `${a.description} (${a.industry}). Fictional company. ${NOTE}`,
      Plan__c: a.plan,
      Committed_Spend__c: committedSpend(a),
      Renewal_Date__c: a.renewalDate ?? null,
    })),
  }),
});
checkResults("Account upsert", accountResults);
const accountIds = new Map(ACCOUNTS.map((a, i) => [a.key, accountResults[i].id]));
console.log(
  `Accounts: ${accountResults.filter((r) => r.created).length} created, ${accountResults.filter((r) => !r.created).length} updated.`,
);

// 5. Contacts (matched by email; the first contact is the primary one)
const contactIds = new Map(
  (await sfQuery<{ Id: string; Email: string }>(`SELECT Id, Email FROM Contact WHERE Account.Usage_Account_Key__c != null`)).map(
    (c) => [c.Email?.toLowerCase(), c.Id],
  ),
);
const contacts = await saveCollection(
  "Contact",
  ACCOUNTS.flatMap((a) =>
    a.contacts.map((c, i) => {
      const email = contactEmail(a, c);
      return {
        ...(contactIds.has(email) ? { Id: contactIds.get(email) } : { AccountId: accountIds.get(a.key) }),
        FirstName: c.firstName,
        LastName: c.lastName,
        Title: c.title,
        Email: email,
        Description: i === 0 ? "Primary contact" : null,
      };
    }),
  ),
);
console.log(`Contacts: ${contacts.created} created, ${contacts.updated} updated.`);

// 6. Open opportunities (matched by name)
const opportunityIds = new Map(
  (await sfQuery<{ Id: string; Name: string }>(`SELECT Id, Name FROM Opportunity WHERE Account.Usage_Account_Key__c != null`)).map(
    (o) => [o.Name, o.Id],
  ),
);
const opportunities = await saveCollection(
  "Opportunity",
  ACCOUNTS.filter((a) => a.openOpportunity).map((a) => {
    const o = a.openOpportunity!;
    return {
      ...(opportunityIds.has(o.name) ? { Id: opportunityIds.get(o.name) } : { AccountId: accountIds.get(a.key) }),
      Name: o.name,
      StageName: o.stage,
      Amount: o.amount,
      CloseDate: o.closeDate,
    };
  }),
);
console.log(`Opportunities: ${opportunities.created} created, ${opportunities.updated} updated.`);

// 7. Read back exactly what the daily workflow will see
const crm = await loadCrmAccounts();
console.log(
  `Workflow view: ${crm.length} accounts, ${crm.filter((a) => a.plan === "Committed").length} committed, ` +
    `${crm.filter((a) => a.hasOpenOpportunity).length} with an open opportunity.`,
);
