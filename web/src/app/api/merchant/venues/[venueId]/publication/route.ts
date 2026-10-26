import { withMerchantOperations } from "@/server/merchant-operations-route";

type RouteContext = { params: Promise<{ venueId: string }> };

export async function GET(request: Request, context: RouteContext) {
  const { venueId } = await context.params;
  return withMerchantOperations(request, (handlers) => handlers.publication(request, venueId));
}

export async function POST(request: Request, context: RouteContext) {
  const { venueId } = await context.params;
  return withMerchantOperations(request, (handlers) => handlers.unpublish(request, venueId));
}
