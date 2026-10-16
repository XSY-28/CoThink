/** Pure shared edit admission policy. No state or I/O is touched on rejection. */
export function editLimitViolation(
  request: { readonly operation: string; readonly edits?: readonly { readonly text: string }[] },
  limits: { maxEditsPerRequest: number; maxTextBytes: number }
): "edit_limit" | "text_limit" | undefined {
  if (request.operation !== "edit" || !Array.isArray(request.edits)) return;
  if (request.edits.length > limits.maxEditsPerRequest) return "edit_limit";
  let bytes = 0;
  for (const edit of request.edits) {
    if (typeof edit?.text !== "string") continue;
    if (edit.text.length > limits.maxTextBytes) return "text_limit";
    bytes += new TextEncoder().encode(edit.text).byteLength;
    if (bytes > limits.maxTextBytes) return "text_limit";
  }
}
