import { handle, json } from "@/lib/http";
import { getPlans } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return handle(async () => {
    const plans = await getPlans();
    return json(
      { ok: true, plan: "pro", periodicity: "MONTHLY", prices: plans.pro, fetchedAt: plans.fetchedAt },
      { headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=600" } },
    );
  });
}
