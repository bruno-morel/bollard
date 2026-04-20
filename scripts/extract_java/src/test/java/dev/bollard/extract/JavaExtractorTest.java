package dev.bollard.extract;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import org.junit.jupiter.api.Test;

class JavaExtractorTest {

  @Test
  void extractsPublicClass() throws Exception {
    Path p =
        Path.of("src/test/resources/Sample.java")
            .toAbsolutePath()
            .normalize();
    JsonOutput.ExtractionBatch batch = JavaExtractor.extract(p);
    String sig = batch.signatures.get(0).signatures;
    assertTrue(sig.contains("public class Sample"));
    assertTrue(sig.contains("getName"));
  }
}
