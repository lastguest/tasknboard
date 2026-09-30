cask "tasknboard" do
  version :latest
  sha256 :no_check

  url "https://github.com/lastguest/tasknboard/releases/download/latest/TasknBoard-macos-arm64.zip"
  name "TasknBoard"
  desc "Kanban workspace for people and coding agents"
  homepage "https://github.com/lastguest/tasknboard"

  depends_on arch: :arm64
  depends_on macos: :ventura

  app "TasknBoard.app"

  caveats do
    <<~EOS
      TasknBoard requires macOS 13.5 or later on Apple Silicon.
      This build is ad-hoc signed and is not notarized.
      If macOS blocks the first launch, review the release before running:
        xattr -dr com.apple.quarantine "#{appdir}/TasknBoard.app"
    EOS
  end
end
