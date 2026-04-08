package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestExtractExportedFunc(t *testing.T) {
	dir := t.TempDir()
	src := `package sample

// ExportedFunc does something useful.
func ExportedFunc(x int, y string) (string, error) {
	return y, nil
}

func unexportedHelper() {}
`
	path := filepath.Join(dir, "sample.go")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	result := ExtractFiles([]string{path}, dir)
	if len(result.Warnings) > 0 {
		t.Errorf("unexpected warnings: %v", result.Warnings)
	}
	if len(result.Signatures) != 1 {
		t.Fatalf("expected 1 signature entry, got %d", len(result.Signatures))
	}

	sig := result.Signatures[0]
	if !strings.Contains(sig.Signatures, "ExportedFunc") {
		t.Error("expected ExportedFunc in signatures")
	}
	if strings.Contains(sig.Signatures, "unexportedHelper") {
		t.Error("unexported func should not appear in signatures")
	}
	if sig.FilePath != path {
		t.Errorf("expected filePath=%q, got %q", path, sig.FilePath)
	}
}

func TestExtractTypes(t *testing.T) {
	dir := t.TempDir()
	src := `package sample

type MyStruct struct {
	Name string
	Age  int
}

type MyInterface interface {
	DoSomething(x int) error
	String() string
}

type MyAlias = string
`
	path := filepath.Join(dir, "types.go")
	if err := os.WriteFile(path, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}

	result := ExtractFiles([]string{path}, dir)
	if len(result.Warnings) > 0 {
		t.Errorf("unexpected warnings: %v", result.Warnings)
	}
	if len(result.Types) != 3 {
		t.Fatalf("expected 3 type definitions, got %d", len(result.Types))
	}

	kinds := make(map[string]string)
	for _, td := range result.Types {
		kinds[td.Name] = td.Kind
	}

	if kinds["MyStruct"] != "type" {
		t.Errorf("expected MyStruct kind=type, got %q", kinds["MyStruct"])
	}
	if kinds["MyInterface"] != "interface" {
		t.Errorf("expected MyInterface kind=interface, got %q", kinds["MyInterface"])
	}
	if kinds["MyAlias"] != "type" {
		t.Errorf("expected MyAlias kind=type, got %q", kinds["MyAlias"])
	}
}

func TestParseErrorProducesWarning(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.go")
	if err := os.WriteFile(path, []byte("this is not valid Go!!!"), 0o644); err != nil {
		t.Fatal(err)
	}

	result := ExtractFiles([]string{path}, dir)
	if len(result.Warnings) == 0 {
		t.Error("expected at least one warning for unparseable file")
	}
	if len(result.Signatures) != 1 {
		t.Fatalf("expected 1 signature entry (empty), got %d", len(result.Signatures))
	}
	if result.Signatures[0].Signatures != "" {
		t.Error("expected empty signatures for unparseable file")
	}
}
