import type { NodeKind } from "@/lib/db/schema";

/** Константы админки, безопасные для клиентских компонентов (без БД и env). */
export const NODE_KINDS: NodeKind[] = ["free_primary", "pro_dns", "pro_worker", "dedicated"];
