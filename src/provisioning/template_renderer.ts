import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export class TemplateRenderer {
  private resolveTemplatePath(relativePath: string): string {
    const distRelativePath = join(__dirname, "..", "templates", relativePath);
    if (existsSync(distRelativePath)) {
      return distRelativePath;
    }

    const sourceRelativePath = join(__dirname, "..", "..", "src", "templates", relativePath);
    if (existsSync(sourceRelativePath)) {
      return sourceRelativePath;
    }

    throw new Error(`Template was not found at ${distRelativePath} or ${sourceRelativePath}`);
  }

  render(relativePath: string, context: Record<string, string>): string {
    const template = readFileSync(this.resolveTemplatePath(relativePath), "utf8");
    return template.replace(/{{\s*([a-zA-Z0-9_]+)\s*}}/g, (_match, key: string) => {
      const value = context[key];
      if (value === undefined) {
        throw new Error(`Missing template value for key '${key}' in '${relativePath}'`);
      }
      return value;
    });
  }
}
