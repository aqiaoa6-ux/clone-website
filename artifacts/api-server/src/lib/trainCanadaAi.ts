import { getCanadaAiModelPath, saveCanadaAiModel, trainCanadaAiModel, type CanadaAiDigits } from "./canadaAi.js";

type DrawItem = {
  term?: number;
  r3?: string;
  sum1?: number;
  sum2?: number;
  sum3?: number;
};

function extractDrawDigits(item: DrawItem): CanadaAiDigits | null {
  const digits = [item.sum1, item.sum2, item.sum3].map(v => Number(v));
  if (digits.some(v => !Number.isInteger(v) || v < 0 || v > 9)) return null;
  return digits as CanadaAiDigits;
}

async function fetchCanadaDigitHistory(): Promise<CanadaAiDigits[]> {
  const res = await fetch("http://pc20.net/api/fengpan", {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "http://pc20.net/",
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const data = await res.json() as { message?: { all?: { keno28?: { data?: DrawItem[] } } } };
  const items = data?.message?.all?.keno28?.data ?? [];
  return items
    .map(extractDrawDigits)
    .filter((item): item is CanadaAiDigits => item !== null)
    .reverse();
}

async function main() {
  const digitHistory = await fetchCanadaDigitHistory();
  const model = trainCanadaAiModel(digitHistory);
  if (!model) throw new Error(`history too short: ${digitHistory.length}`);
  const filePath = getCanadaAiModelPath();
  saveCanadaAiModel(model, filePath);
  console.log(`canada ai model saved: ${filePath}`);
  console.log(`history: ${digitHistory.length}, models: ${model.models.length}`);
  for (const item of model.models) {
    console.log(`${item.axis}-${item.family}: acc=${(item.accuracy * 100).toFixed(1)}% samples=${item.sampleCount}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
