import XCTest
import SwiftTreeSitter
import TreeSitterDsl

final class TreeSitterDslTests: XCTestCase {
    func testCanLoadGrammar() throws {
        let parser = Parser()
        let language = Language(language: tree_sitter_indent())
        XCTAssertNoThrow(try parser.setLanguage(language),
                         "Error loading Indent grammar")
    }
}
