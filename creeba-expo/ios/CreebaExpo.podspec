require "json"

package = JSON.parse(File.read(File.join(__dir__, "..", "package.json")))

Pod::Spec.new do |s|
  s.name           = "CreebaExpo"
  s.version        = package["version"]
  s.summary        = package["description"]
  s.license        = "MIT"
  s.author         = "Creeba"
  s.homepage       = "https://github.com/DATAGNIKAN/creeba"
  # iroh-ffi 1.0 requires iOS 17.5 (see Package.swift).
  s.platforms      = { :ios => "17.5" }
  s.swift_version  = "5.9"
  s.source         = { git: "" }
  s.static_framework = true

  s.dependency "ExpoModulesCore"

  # iroh-ffi Swift Package dependency via the `cocoapods-spm` plugin. The package
  # SOURCE (repo/tag) is declared in the Podfile by the config plugin
  # (`plugin 'cocoapods-spm'` + `spm_pkg "IrohLib", …`). Prerequisite: the
  # `cocoapods-spm` gem must be installed (see the "iOS" README).
  s.spm_dependency "IrohLib/IrohLib"

  # iroh-ffi links these system frameworks (see Package.swift: SystemConfiguration
  # for its hickory DNS resolver, Network for interface enumeration). SPM
  # `.linkedFramework`s do not propagate to the app binary via cocoapods-spm, so
  # we redeclare them here to avoid missing symbols (_SCDynamicStore*).
  s.frameworks = "SystemConfiguration", "Network"

  s.pod_target_xcconfig = {
    "DEFINES_MODULE" => "YES",
    "SWIFT_COMPILATION_MODE" => "wholemodule"
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
