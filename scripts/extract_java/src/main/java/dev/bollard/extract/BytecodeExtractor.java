package dev.bollard.extract;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.FieldVisitor;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/** ASM-based public API extraction from compiled .class files. */
public final class BytecodeExtractor {

  private BytecodeExtractor() {}

  public static JsonOutput.ExtractionBatch extract(Path absPath) throws IOException {
    byte[] bytes = Files.readAllBytes(absPath);
    ClassReader cr = new ClassReader(bytes);
    Extractor cv = new Extractor();
    cr.accept(cv, ClassReader.SKIP_DEBUG);
    String filePath = absPath.toString();
    String sigs = String.join("\n", cv.lines);
    JsonOutput.ExtractedSignature sig =
        new JsonOutput.ExtractedSignature(filePath, sigs, "", "");
    return new JsonOutput.ExtractionBatch(List.of(sig), List.of(), List.of());
  }

  private static final class Extractor extends ClassVisitor {
    final List<String> lines = new ArrayList<>();
    String className = "";

    Extractor() {
      super(Opcodes.ASM9);
    }

    @Override
    public void visit(
        int version,
        int access,
        String name,
        String signature,
        String superName,
        String[] interfaces) {
      if ((access & Opcodes.ACC_PUBLIC) != 0 || (access & Opcodes.ACC_PROTECTED) != 0) {
        className = name.replace('/', '.');
        String kind =
            (access & Opcodes.ACC_INTERFACE) != 0
                ? "interface"
                : (access & Opcodes.ACC_ENUM) != 0
                    ? "enum"
                    : "class";
        lines.add(kind + " " + className);
      }
    }

    @Override
    public FieldVisitor visitField(
        int access, String name, String descriptor, String signature, Object value) {
      if (name != null && ((access & Opcodes.ACC_PUBLIC) != 0 || (access & Opcodes.ACC_PROTECTED) != 0)) {
        lines.add(descriptor + " " + name);
      }
      return null;
    }

    @Override
    public MethodVisitor visitMethod(
        int access, String name, String descriptor, String signature, String[] exceptions) {
      if (name != null
          && !"<clinit>".equals(name)
          && ((access & Opcodes.ACC_PUBLIC) != 0 || (access & Opcodes.ACC_PROTECTED) != 0)) {
        if ("<init>".equals(name)) {
          lines.add(className + descriptor);
        } else {
          lines.add(descriptor + " " + name);
        }
      }
      return null;
    }
  }
}
