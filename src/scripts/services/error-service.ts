export const chainableError = (
  error?: unknown
): { readonly cause: Error | undefined } => {
  const e =
    error === undefined
      ? undefined
      : error instanceof Error
      ? error
      : typeof error === 'string'
      ? new Error(error)
      : new Error(JSON.stringify(error));

  return { cause: e };
};
