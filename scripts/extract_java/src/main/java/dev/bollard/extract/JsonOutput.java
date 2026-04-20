package dev.bollard.extract;

import java.util.List;

/** Minimal JSON serialization (no external JSON library). */
public final class JsonOutput {

  private JsonOutput() {}

  public static String escape(String s) {
    if (s == null) {
      return "";
    }
    StringBuilder sb = new StringBuilder(s.length() + 16);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '\\' -> sb.append("\\\\");
        case '"' -> sb.append("\\\"");
        case '\n' -> sb.append("\\n");
        case '\r' -> sb.append("\\r");
        case '\t' -> sb.append("\\t");
        default -> {
          if (c < 0x20) {
            sb.append(String.format("\\u%04x", (int) c));
          } else {
            sb.append(c);
          }
        }
      }
    }
    return sb.toString();
  }

  public static String toJson(ExtractionBatch batch) {
    StringBuilder out = new StringBuilder(1024);
    out.append("{\"signatures\":[");
    for (int i = 0; i < batch.signatures.size(); i++) {
      if (i > 0) out.append(',');
      sigToJson(out, batch.signatures.get(i));
    }
    out.append("],\"types\":[");
    for (int i = 0; i < batch.types.size(); i++) {
      if (i > 0) out.append(',');
      typeToJson(out, batch.types.get(i));
    }
    out.append("],\"warnings\":[");
    for (int i = 0; i < batch.warnings.size(); i++) {
      if (i > 0) out.append(',');
      out.append('"').append(escape(batch.warnings.get(i))).append('"');
    }
    out.append("]}");
    return out.toString();
  }

  private static void sigToJson(StringBuilder out, ExtractedSignature s) {
    out.append("{\"filePath\":\"")
        .append(escape(s.filePath))
        .append("\",\"signatures\":\"")
        .append(escape(s.signatures))
        .append("\",\"types\":\"")
        .append(escape(s.types))
        .append("\",\"imports\":\"")
        .append(escape(s.imports))
        .append("\"}");
  }

  private static void typeToJson(StringBuilder out, ExtractedTypeDef t) {
    out.append("{\"name\":\"")
        .append(escape(t.name))
        .append("\",\"kind\":\"")
        .append(escape(t.kind))
        .append("\",\"definition\":\"")
        .append(escape(t.definition))
        .append("\",\"filePath\":\"")
        .append(escape(t.filePath))
        .append("\"}");
  }

  public static final class ExtractedSignature {
    public final String filePath;
    public final String signatures;
    public final String types;
    public final String imports;

    public ExtractedSignature(String filePath, String signatures, String types, String imports) {
      this.filePath = filePath;
      this.signatures = signatures;
      this.types = types;
      this.imports = imports;
    }
  }

  public static final class ExtractedTypeDef {
    public final String name;
    public final String kind;
    public final String definition;
    public final String filePath;

    public ExtractedTypeDef(String name, String kind, String definition, String filePath) {
      this.name = name;
      this.kind = kind;
      this.definition = definition;
      this.filePath = filePath;
    }
  }

  public static final class ExtractionBatch {
    public final List<ExtractedSignature> signatures;
    public final List<ExtractedTypeDef> types;
    public final List<String> warnings;

    public ExtractionBatch(
        List<ExtractedSignature> signatures, List<ExtractedTypeDef> types, List<String> warnings) {
      this.signatures = signatures;
      this.types = types;
      this.warnings = warnings;
    }
  }
}
