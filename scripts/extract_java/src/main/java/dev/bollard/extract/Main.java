package dev.bollard.extract;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

public final class Main {

  private static final String VERSION = "1.0.0";

  private Main() {}

  public static void main(String[] args) {
    if (args.length == 0) {
      System.err.println(
          "usage: bollard-extract-java [--version] [--kotlin] [--bytecode] <files...>");
      System.exit(1);
    }

    List<String> files = new ArrayList<>();
    boolean kotlin = false;
    boolean bytecode = false;

    for (String a : args) {
      switch (a) {
        case "--version" -> {
          System.out.println("bollard-extract-java " + VERSION);
          return;
        }
        case "--kotlin" -> kotlin = true;
        case "--bytecode" -> bytecode = true;
        default -> files.add(a);
      }
    }

    if (files.isEmpty()) {
      System.err.println("error: no input files");
      System.exit(1);
    }

    List<JsonOutput.ExtractedSignature> sigs = new ArrayList<>();
    List<JsonOutput.ExtractedTypeDef> types = new ArrayList<>();
    List<String> warnings = new ArrayList<>();

    for (String fp : files) {
      Path p = Path.of(fp);
      try {
        JsonOutput.ExtractionBatch batch;
        if (bytecode || fp.endsWith(".class")) {
          batch = BytecodeExtractor.extract(p);
        } else if (kotlin || fp.endsWith(".kt")) {
          batch = KotlinRegexExtractor.extract(p);
        } else {
          batch = JavaExtractor.extract(p);
        }
        sigs.addAll(batch.signatures);
        types.addAll(batch.types);
        warnings.addAll(batch.warnings);
      } catch (Exception e) {
        warnings.add(p + ": " + e.getMessage());
        sigs.add(new JsonOutput.ExtractedSignature(fp, "", "", ""));
      }
    }

    JsonOutput.ExtractionBatch out = new JsonOutput.ExtractionBatch(sigs, types, warnings);
    System.out.println(JsonOutput.toJson(out));
  }
}
