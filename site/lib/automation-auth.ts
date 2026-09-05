export function isAutomationAuthorized(request: Request, expected?: string): boolean {
  if (!expected) return false;
  const supplied = request.headers.get('x-automation-key') ?? '';
  if (supplied.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}
