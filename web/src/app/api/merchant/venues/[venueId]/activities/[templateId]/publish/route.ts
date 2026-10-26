import { withMerchantOperations } from "@/server/merchant-operations-route";

type RouteContext = { params: Promise<{ venueId: string; templateId: string }> };

export async function POST(request: Request, context: RouteContext) {
  const { venueId, templateId } = await context.params;
  return withMerchantOperations(request, (handlers) => handlers.publish(request, venueId, templateId));
}
