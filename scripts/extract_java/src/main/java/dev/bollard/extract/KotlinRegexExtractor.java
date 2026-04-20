package dev.bollard.extract;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Wave 1: regex-based public API hints for Kotlin sources. */
public final class KotlinRegexExtractor {

  private KotlinRegexExtractor() {}

  private static final Pattern FUN =
      Pattern.compile(
          "^\\s*(?!private\\s+fun\\b)(?!internal\\s+fun\\b)(?:@[^\\n]+\\s*)*(?:inline\\s+|suspend\\s+)*fun\\s+(?:<[^>]+>\\s+)?([`\\w.]+)\\s*[\\(:]",
          Pattern.MULTILINE);
  private static final Pattern CLASS =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)(?:@[^\\n]+\\s*)*(?:data\\s+|sealed\\s+|abstract\\s+)?class\\s+([A-Za-z_][\\w]*)",
          Pattern.MULTILINE);
  private static final Pattern INTERFACE =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)(?:@[^\\n]+\\s*)*interface\\s+([A-Za-z_][\\w]*)",
          Pattern.MULTILINE);
  private static final Pattern OBJECT =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)(?:@[^\\n]+\\s*)*object\\s+([A-Za-z_][\\w]*)",
          Pattern.MULTILINE);
  private static final Pattern ENUM =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)*enum\\s+class\\s+([A-Za-z_][\\w]*)",
          Pattern.MULTILINE);
  private static final Pattern VAL =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)(?:@[^\\n]+\\s*)*(?:const\\s+)?val\\s+([A-Za-z_][\\w]*)\\s*:",
          Pattern.MULTILINE);
  private static final Pattern VAR =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)(?:@[^\\n]+\\s*)*var\\s+([A-Za-z_][\\w]*)\\s*:",
          Pattern.MULTILINE);
  private static final Pattern TYPEALIAS =
      Pattern.compile(
          "^(?!\\s*(?:private|internal)\\s)*typealias\\s+([A-Za-z_][\\w]*)\\s*=",
          Pattern.MULTILINE);

  public static JsonOutput.ExtractionBatch extract(Path absPath) throws IOException {
    String source = Files.readString(absPath);
    String filePath = absPath.toString();
    List<String> lines = new ArrayList<>();

    addMatches(lines, FUN, source, "fun ");
    addMatches(lines, CLASS, source, "class ");
    addMatches(lines, INTERFACE, source, "interface ");
    addMatches(lines, OBJECT, source, "object ");
    addMatches(lines, ENUM, source, "enum class ");
    addMatches(lines, VAL, source, "val ");
    addMatches(lines, VAR, source, "var ");
    addMatches(lines, TYPEALIAS, source, "typealias ");

    String signatures = String.join("\n", lines);
    JsonOutput.ExtractedSignature sig =
        new JsonOutput.ExtractedSignature(filePath, signatures, "", "");
    return new JsonOutput.ExtractionBatch(List.of(sig), List.of(), List.of());
  }

  private static void addMatches(List<String> out, Pattern p, String source, String prefix) {
    Matcher m = p.matcher(source);
    while (m.find()) {
      if (m.group(1) != null) {
        out.add(prefix + m.group(1).replace('`', ' ').trim());
      }
    }
  }
}
