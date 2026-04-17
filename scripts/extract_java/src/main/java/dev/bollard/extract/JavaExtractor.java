package dev.bollard.extract;

import com.github.javaparser.JavaParser;
import com.github.javaparser.ParseResult;
import com.github.javaparser.ParserConfiguration;
import com.github.javaparser.ast.CompilationUnit;
import com.github.javaparser.ast.ImportDeclaration;
import com.github.javaparser.ast.body.BodyDeclaration;
import com.github.javaparser.ast.body.ClassOrInterfaceDeclaration;
import com.github.javaparser.ast.body.ConstructorDeclaration;
import com.github.javaparser.ast.body.EnumConstantDeclaration;
import com.github.javaparser.ast.body.EnumDeclaration;
import com.github.javaparser.ast.body.FieldDeclaration;
import com.github.javaparser.ast.body.MethodDeclaration;
import com.github.javaparser.ast.body.RecordDeclaration;
import com.github.javaparser.ast.body.TypeDeclaration;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/** JavaParser-based extraction of public/protected API from .java sources. */
public final class JavaExtractor {

  /**
   * RAW (null language level) skips validators/post-processors — required for GraalVM native-image
   * where JavaParser's reflection-heavy validators can throw {@link NoSuchFieldError}.
   */
  private static final JavaParser PARSER =
      new JavaParser(
          new ParserConfiguration().setLanguageLevel(ParserConfiguration.LanguageLevel.RAW));

  private JavaExtractor() {}

  public static JsonOutput.ExtractionBatch extract(Path absPath) throws IOException {
    String source = Files.readString(absPath);
    ParseResult<CompilationUnit> pr = PARSER.parse(source);
    CompilationUnit cu =
        pr.getResult()
            .orElseThrow(
                () ->
                    new IOException(
                        "parse failed: " + pr.getProblems().stream().map(Object::toString).toList()));
    String filePath = absPath.toString();

    List<String> importLines = new ArrayList<>();
    for (ImportDeclaration imp : cu.getImports()) {
      importLines.add(imp.toString().trim());
    }

    List<String> sigLines = new ArrayList<>();
    List<JsonOutput.ExtractedTypeDef> typeDefs = new ArrayList<>();

    for (TypeDeclaration<?> t : cu.getTypes()) {
      extractTypeDecl(t, filePath, sigLines, typeDefs);
    }

    String imports = String.join("\n", importLines);
    String signatures = String.join("\n", sigLines);
    String typesStr =
        typeDefs.stream()
            .map(d -> d.definition)
            .reduce((a, b) -> a + "\n\n" + b)
            .orElse("");

    JsonOutput.ExtractedSignature sig =
        new JsonOutput.ExtractedSignature(filePath, signatures, typesStr, imports);
    return new JsonOutput.ExtractionBatch(List.of(sig), typeDefs, List.of());
  }

  private static boolean isExported(BodyDeclaration<?> n) {
    if (n instanceof MethodDeclaration md) {
      return md.isPublic() || md.isProtected();
    }
    if (n instanceof ConstructorDeclaration cd) {
      return cd.isPublic() || cd.isProtected();
    }
    if (n instanceof TypeDeclaration<?> td) {
      return td.isPublic() || td.isProtected();
    }
    if (n instanceof FieldDeclaration fd) {
      return fd.isPublic() || fd.isProtected();
    }
    return false;
  }

  private static void extractTypeDecl(
      TypeDeclaration<?> decl,
      String filePath,
      List<String> sigLines,
      List<JsonOutput.ExtractedTypeDef> typeDefs) {
    if (!isExported(decl)) {
      return;
    }

    if (decl instanceof ClassOrInterfaceDeclaration cid) {
      String header = truncateAtBrace(cid.toString());
      sigLines.add(header);
      String kind = cid.isInterface() ? "interface" : "type";
      typeDefs.add(
          new JsonOutput.ExtractedTypeDef(
              cid.getNameAsString(), kind, stubTypeDef(cid.toString()), filePath));
      for (BodyDeclaration<?> m : cid.getMembers()) {
        extractMember(m, filePath, sigLines, typeDefs);
      }
      return;
    }

    if (decl instanceof EnumDeclaration ed) {
      String header = truncateAtBrace(ed.toString());
      sigLines.add(header);
      typeDefs.add(
          new JsonOutput.ExtractedTypeDef(
              ed.getNameAsString(), "enum", stubTypeDef(ed.toString()), filePath));
      for (EnumConstantDeclaration c : ed.getEntries()) {
        sigLines.add("  " + c.getNameAsString());
      }
      for (BodyDeclaration<?> m : ed.getMembers()) {
        extractMember(m, filePath, sigLines, typeDefs);
      }
      return;
    }

    if (decl instanceof RecordDeclaration rd) {
      String header = truncateAtBrace(rd.toString());
      sigLines.add(header);
      typeDefs.add(
          new JsonOutput.ExtractedTypeDef(
              rd.getNameAsString(), "type", stubTypeDef(rd.toString()), filePath));
      for (BodyDeclaration<?> m : rd.getMembers()) {
        extractMember(m, filePath, sigLines, typeDefs);
      }
    }
  }

  private static String truncateAtBrace(String s) {
    int i = s.indexOf('{');
    return i > 0 ? s.substring(0, i).trim() : s.trim();
  }

  private static String stubTypeDef(String full) {
    int brace = full.indexOf('{');
    if (brace < 0) {
      return full.trim();
    }
    return full.substring(0, brace).trim() + " {\n  ...\n}";
  }

  private static void extractMember(
      BodyDeclaration<?> m,
      String filePath,
      List<String> sigLines,
      List<JsonOutput.ExtractedTypeDef> typeDefs) {
    if (m instanceof MethodDeclaration md) {
      if (isExported(md)) {
        sigLines.add(md.getDeclarationAsString(true, true, true) + " { ... }");
      }
      return;
    }
    if (m instanceof ConstructorDeclaration cd) {
      if (isExported(cd)) {
        sigLines.add(cd.getDeclarationAsString(true, true, true) + " { ... }");
      }
      return;
    }
    if (m instanceof FieldDeclaration fd) {
      if (isExported(fd)) {
        sigLines.add(fd.toString().trim());
      }
      return;
    }
    if (m instanceof TypeDeclaration<?> nested) {
      extractTypeDecl(nested, filePath, sigLines, typeDefs);
    }
  }
}
