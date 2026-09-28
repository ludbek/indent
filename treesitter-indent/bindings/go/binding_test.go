package tree_sitter_indent_test

import (
	"testing"

	tree_sitter "github.com/tree-sitter/go-tree-sitter"
	tree_sitter_indent "github.com/tree-sitter/treesitter-indent/bindings/go"
)

func TestCanLoadGrammar(t *testing.T) {
	language := tree_sitter.NewLanguage(tree_sitter_indent.Language())
	if language == nil {
		t.Errorf("Error loading Indent grammar")
	}
}
