import { withMerchantOperations } from "@/server/merchant-operations-route";

type RouteContext = { params: Promise<{ venueId: string; tableId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { venueId, tableId } = await context.params;
  return withMerchantOperations(request, (handlers) => handlers.rotateTableCode(request, venueId, tableId));
}
