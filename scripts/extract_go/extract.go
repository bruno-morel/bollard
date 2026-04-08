package main

import (
	"bytes"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"strings"
)

// ExtractedSignature matches the TypeScript ExtractedSignature interface in type-extractor.ts.
type ExtractedSignature struct {
	FilePath   string `json:"filePath"`
	Signatures string `json:"signatures"`
	Types      string `json:"types"`
	Imports    string `json:"imports"`
}

// ExtractedTypeDefinition matches the TypeScript ExtractedTypeDefinition interface.
type ExtractedTypeDefinition struct {
	Name       string `json:"name"`
	Kind       string `json:"kind"`
	Definition string `json:"definition"`
	FilePath   string `json:"filePath"`
}

// ExtractionResult is the top-level JSON output shape.
type ExtractionResult struct {
	Signatures []ExtractedSignature      `json:"signatures"`
	Types      []ExtractedTypeDefinition `json:"types"`
	Warnings   []string                  `json:"warnings,omitempty"`
}

// ExtractFiles processes each path, skipping files outside cwd.
func ExtractFiles(paths []string, cwd string) ExtractionResult {
	result := ExtractionResult{
		Signatures: make([]ExtractedSignature, 0, len(paths)),
		Types:      make([]ExtractedTypeDefinition, 0),
	}

	cwdAbs, err := filepath.Abs(cwd)
	if err != nil {
		cwdAbs = cwd
	}

	for _, p := range paths {
		absPath, err := filepath.Abs(p)
		if err != nil {
			fmt.Fprintf(os.Stderr, "{\"warning\": \"cannot resolve path: %s\"}\n", p)
			continue
		}

		if !strings.HasPrefix(absPath, cwdAbs+string(filepath.Separator)) && absPath != cwdAbs {
			fmt.Fprintf(os.Stderr, "{\"warning\": \"skipping path outside cwd: %s\"}\n", p)
			continue
		}

		sig, types, warnings := extractFile(absPath)
		result.Signatures = append(result.Signatures, sig)
		result.Types = append(result.Types, types...)
		result.Warnings = append(result.Warnings, warnings...)
	}

	return result
}

func extractFile(filePath string) (ExtractedSignature, []ExtractedTypeDefinition, []string) {
	fset := token.NewFileSet()
	file, err := parser.ParseFile(fset, filePath, nil, parser.ParseComments)
	if err != nil {
		return ExtractedSignature{
			FilePath:   filePath,
			Signatures: "",
			Types:      "",
			Imports:    "",
		}, nil, []string{fmt.Sprintf("%s: %v", filePath, err)}
	}

	var sigLines []string
	var typeDetailLines []string
	var importLines []string
	var typeDefs []ExtractedTypeDefinition

	for _, imp := range file.Imports {
		var line string
		if imp.Name != nil {
			line = imp.Name.Name + " " + imp.Path.Value
		} else {
			line = imp.Path.Value
		}
		importLines = append(importLines, line)
	}

	for _, decl := range file.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			extractFuncDecl(fset, d, filePath, &sigLines, &typeDefs)
		case *ast.GenDecl:
			extractGenDecl(fset, d, filePath, &sigLines, &typeDetailLines, &typeDefs)
		}
	}

	return ExtractedSignature{
		FilePath:   filePath,
		Signatures: strings.Join(sigLines, "\n"),
		Types:      strings.Join(typeDetailLines, "\n"),
		Imports:    strings.Join(importLines, "\n"),
	}, typeDefs, nil
}

func extractFuncDecl(
	fset *token.FileSet,
	d *ast.FuncDecl,
	filePath string,
	sigLines *[]string,
	_ *[]ExtractedTypeDefinition,
) {
	if d.Name == nil || !d.Name.IsExported() {
		return
	}
	if d.Recv != nil && len(d.Recv.List) > 0 {
		if recvType := receiverTypeName(d.Recv.List[0].Type); recvType != "" {
			if len(recvType) > 0 && recvType[0] >= 'a' && recvType[0] <= 'z' {
				return
			}
		}
	}

	savedBody := d.Body
	d.Body = nil
	sig := printNode(fset, d)
	d.Body = savedBody
	*sigLines = append(*sigLines, sig)
}

func receiverTypeName(expr ast.Expr) string {
	switch t := expr.(type) {
	case *ast.StarExpr:
		return receiverTypeName(t.X)
	case *ast.Ident:
		return t.Name
	case *ast.IndexExpr:
		return receiverTypeName(t.X)
	case *ast.IndexListExpr:
		return receiverTypeName(t.X)
	}
	return ""
}

func extractGenDecl(
	fset *token.FileSet,
	d *ast.GenDecl,
	filePath string,
	sigLines *[]string,
	typeDetailLines *[]string,
	typeDefs *[]ExtractedTypeDefinition,
) {
	switch d.Tok {
	case token.TYPE:
		extractTypeDecls(fset, d, filePath, sigLines, typeDetailLines, typeDefs)
	case token.CONST:
		extractConstDecls(fset, d, filePath, sigLines, typeDefs)
	case token.VAR:
		extractVarDecls(fset, d, sigLines)
	}
}

func extractTypeDecls(
	fset *token.FileSet,
	d *ast.GenDecl,
	filePath string,
	sigLines *[]string,
	typeDetailLines *[]string,
	typeDefs *[]ExtractedTypeDefinition,
) {
	for _, spec := range d.Specs {
		ts, ok := spec.(*ast.TypeSpec)
		if !ok || !ts.Name.IsExported() {
			continue
		}

		kind := "type"
		defStr := printTypeDecl(fset, ts)

		switch t := ts.Type.(type) {
		case *ast.InterfaceType:
			kind = "interface"
			if t.Methods != nil && t.Methods.NumFields() > 0 {
				*typeDetailLines = append(*typeDetailLines, printNode(fset, t))
			}
		case *ast.StructType:
			if t.Fields != nil && t.Fields.NumFields() > 0 {
				*typeDetailLines = append(*typeDetailLines, printNode(fset, t))
			}
		}

		*sigLines = append(*sigLines, defStr)
		*typeDefs = append(*typeDefs, ExtractedTypeDefinition{
			Name:       ts.Name.Name,
			Kind:       kind,
			Definition: defStr,
			FilePath:   filePath,
		})
	}
}

func extractConstDecls(
	fset *token.FileSet,
	d *ast.GenDecl,
	filePath string,
	sigLines *[]string,
	typeDefs *[]ExtractedTypeDefinition,
) {
	enumType, isEnum := detectEnum(d)
	if isEnum && enumType != "" {
		defStr := printNode(fset, d)
		*sigLines = append(*sigLines, defStr)
		*typeDefs = append(*typeDefs, ExtractedTypeDefinition{
			Name:       enumType,
			Kind:       "enum",
			Definition: defStr,
			FilePath:   filePath,
		})
		return
	}

	for _, spec := range d.Specs {
		vs, ok := spec.(*ast.ValueSpec)
		if !ok {
			continue
		}
		for _, name := range vs.Names {
			if !name.IsExported() {
				continue
			}
			constStr := printConstDecl(fset, vs)
			*sigLines = append(*sigLines, constStr)
			*typeDefs = append(*typeDefs, ExtractedTypeDefinition{
				Name:       name.Name,
				Kind:       "const",
				Definition: constStr,
				FilePath:   filePath,
			})
		}
	}
}

func extractVarDecls(
	fset *token.FileSet,
	d *ast.GenDecl,
	sigLines *[]string,
) {
	for _, spec := range d.Specs {
		vs, ok := spec.(*ast.ValueSpec)
		if !ok {
			continue
		}
		for _, name := range vs.Names {
			if !name.IsExported() {
				continue
			}
			varStr := printVarDecl(fset, vs)
			*sigLines = append(*sigLines, varStr)
		}
	}
}

// detectEnum checks if a const block looks like a Go enum (two+ exported names
// sharing a declared type, or any use of iota).
func detectEnum(d *ast.GenDecl) (string, bool) {
	if d.Tok != token.CONST || len(d.Specs) < 2 {
		return "", false
	}

	hasIota := false
	sharedType := ""
	exportedCount := 0

	for _, spec := range d.Specs {
		vs, ok := spec.(*ast.ValueSpec)
		if !ok {
			continue
		}

		for _, val := range vs.Values {
			if containsIota(val) {
				hasIota = true
			}
		}

		if vs.Type != nil {
			if ident, ok := vs.Type.(*ast.Ident); ok {
				if sharedType == "" {
					sharedType = ident.Name
				} else if sharedType != ident.Name {
					return "", false
				}
			}
		}

		for _, name := range vs.Names {
			if name.IsExported() {
				exportedCount++
			}
		}
	}

	if exportedCount < 2 {
		return "", false
	}

	if hasIota || sharedType != "" {
		if sharedType != "" {
			return sharedType, true
		}
		for _, spec := range d.Specs {
			vs, ok := spec.(*ast.ValueSpec)
			if !ok {
				continue
			}
			for _, name := range vs.Names {
				if name.IsExported() {
					return name.Name, true
				}
			}
		}
	}

	return "", false
}

func containsIota(expr ast.Expr) bool {
	switch e := expr.(type) {
	case *ast.Ident:
		return e.Name == "iota"
	case *ast.BinaryExpr:
		return containsIota(e.X) || containsIota(e.Y)
	case *ast.UnaryExpr:
		return containsIota(e.X)
	case *ast.ParenExpr:
		return containsIota(e.X)
	case *ast.CallExpr:
		for _, arg := range e.Args {
			if containsIota(arg) {
				return true
			}
		}
	}
	return false
}

func printNode(fset *token.FileSet, node ast.Node) string {
	var buf bytes.Buffer
	if err := printer.Fprint(&buf, fset, node); err != nil {
		return ""
	}
	return buf.String()
}

func printTypeDecl(fset *token.FileSet, ts *ast.TypeSpec) string {
	gd := &ast.GenDecl{
		Tok:   token.TYPE,
		Specs: []ast.Spec{ts},
	}
	return printNode(fset, gd)
}

func printConstDecl(fset *token.FileSet, vs *ast.ValueSpec) string {
	gd := &ast.GenDecl{
		Tok:   token.CONST,
		Specs: []ast.Spec{vs},
	}
	return printNode(fset, gd)
}

func printVarDecl(fset *token.FileSet, vs *ast.ValueSpec) string {
	gd := &ast.GenDecl{
		Tok:   token.VAR,
		Specs: []ast.Spec{vs},
	}
	return printNode(fset, gd)
}
