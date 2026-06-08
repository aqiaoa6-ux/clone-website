import fs from "fs/promises";
import path from "path";

const dataDir = path.resolve(process.cwd(), "data");
const storePath = path.join(dataDir, "store.json");
const tmpPath = path.join(dataDir, "store.json.tmp");

export async function loadStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(storePath, "utf8");
    const parsed = JSON.parse(raw);
    return normalizeStore(parsed);
  } catch {
    const fresh = normalizeStore({});
    await saveStore(fresh);
    return fresh;
  }
}

export async function saveStore(store) {
  await fs.mkdir(dataDir, { recursive: true });
  const normalized = normalizeStore(store);
  const raw = JSON.stringify(normalized, null, 2);
  await fs.writeFile(tmpPath, raw, "utf8");
  await fs.rename(tmpPath, storePath);
}

function normalizeStore(input) {
  const s = input && typeof input === "object" ? input : {};
  return {
    users: s.users && typeof s.users === "object" ? s.users : {},
    orders: s.orders && typeof s.orders === "object" ? s.orders : {},
    binds: s.binds && typeof s.binds === "object" ? s.binds : {}
  };
}

