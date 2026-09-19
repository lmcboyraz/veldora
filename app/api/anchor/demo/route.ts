import { body, demo, handle } from '@/lib/anchor/server';

export async function POST(request: Request) {
  return handle(request, async () => demo(request, await body(request)));
}
