import { withMerchantOperations } from "@/server/merchant-operations-route";

type RouteContext = { params: Promise<{ venueId: string; tableId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const { venueId, tableId } = await context.params;
  return withMerchantOperations(request, (handlers) => handlers.setTableEnabled(request, venueId, tableId));
}
