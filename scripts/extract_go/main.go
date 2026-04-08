package main

import (
	"encoding/json"
	"fmt"
	"os"
)

const version = "0.1.0"

func main() {
	args := os.Args[1:]

	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "usage: bollard-extract-go [--version] <file1.go> [<file2.go> ...]")
		os.Exit(1)
	}

	if args[0] == "--version" {
		fmt.Printf("bollard-extract-go %s\n", version)
		return
	}

	cwd, err := os.Getwd()
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: cannot determine working directory: %v\n", err)
		os.Exit(1)
	}

	result := ExtractFiles(args, cwd)

	out, err := json.MarshalIndent(result, "", "  ")
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to marshal JSON: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(out))
}
