import { createPlayGroupApiHandlers } from "@/server/play-group-api";

export async function POST(request: Request) {
  return createPlayGroupApiHandlers().create(request);
}
