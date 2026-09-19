import { body, handle, onrampStatus, startOnramp } from '@/lib/anchor/server';

export async function POST(request: Request) {
  return handle(request, async () => startOnramp(request, await body(request)));
}

export async function GET(request: Request) {
  return handle(request, () => onrampStatus(request));
}
