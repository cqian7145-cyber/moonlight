import { createAttemptApiHandlers } from "@/server/attempt-api";

const handlers = createAttemptApiHandlers();

export async function GET(request: Request): Promise<Response> {
  return handlers.questions(request);
}
