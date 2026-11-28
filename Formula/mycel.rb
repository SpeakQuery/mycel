class Mycel < Formula
  desc "One gateway for all your MCP tools: smaller context, results kept out of the chat"
  homepage "https://mycel.speakquery.ai"
  url "https://registry.npmjs.org/@speakquery/mycel/-/mycel-0.3.0.tgz"
  sha256 "67e4a5d180b01049c6b4c323ef182163922caf9f9ca7c10cc1f2f61db312a67c"
  license "Apache-2.0"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~TXT
      Connect your apps (Claude Desktop, Claude Code, Cursor, VS Code, Windsurf, Gemini CLI):
        mycel setup
      Undo any time with: mycel undo
    TXT
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/mycel --version")
  end
end
