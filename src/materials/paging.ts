/** Counts the serialized response, including the digit width of returnedBytes itself. */
export function measured<T extends { returnedBytes: number }>(page: Omit<T, 'returnedBytes'>): T {
  const result = { ...page, returnedBytes: 0 } as T;
  for (let n = 0; n < 8; n++) {
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (result.returnedBytes === bytes) return result;
    result.returnedBytes = bytes;
  }
  throw new Error('Serialized page size did not converge.');
}
