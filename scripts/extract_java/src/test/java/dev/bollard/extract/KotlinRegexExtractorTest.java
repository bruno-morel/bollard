package dev.bollard.extract;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class KotlinRegexExtractorTest {

  @Test
  void extractsFun() throws Exception {
    Path p = Path.of("src/test/resources/Sample.kt").toAbsolutePath().normalize();
    JsonOutput.ExtractionBatch batch = KotlinRegexExtractor.extract(p);
    String sig = batch.signatures.get(0).signatures;
    assertTrue(sig.contains("fun greet") || sig.contains("greet"));
  }
}
