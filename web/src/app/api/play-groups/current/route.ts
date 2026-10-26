import { createPlayGroupApiHandlers } from "@/server/play-group-api";

export async function GET(request: Request) {
  return createPlayGroupApiHandlers().current(request);
}
