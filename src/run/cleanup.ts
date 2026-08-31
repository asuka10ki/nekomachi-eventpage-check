export type Closable = { close(): Promise<unknown> };

export async function closeResources(resources: Array<{ label: string; resource: Closable }>): Promise<string[]> {
  const errors: string[] = [];
  for (const { label, resource } of resources) {
    try {
      await resource.close();
    } catch (error) {
      errors.push(`${label}終了に失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}
