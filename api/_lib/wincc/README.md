# SCAMATIC to WinCC Unified PC V21

This ZIP exports a saved design with a screen layout, static widget defaults, optional JavaScript event handlers, and a Windows project generator.

## Generate the TIA Portal project

1. Extract the complete ZIP into a local folder.
2. Prepare a TIA Portal V21 archive (.zap21) containing one WinCC Unified PC station at the project root. Use an English (United States) template with the same screen resolution as your design.
3. On the engineering PC, use TIA Portal V21 with WinCC Unified PC Engineering and the matching Openness option installed. Use an account in the **Siemens TIA Openness** group.
4. Open 64-bit Windows PowerShell 5.1 in the extracted folder. Choose a new output folder and run:

   ~~~powershell
   .\Generate-WinCCProject.ps1 -TemplateArchive 'D:\TIA\UnifiedTemplate.zap21' -OutputDirectory 'D:\TIA\Generated\TankOverview'
   ~~~

   For a custom installation, supply -ApiDirectory with its PublicAPI\V21\net48 folder.
5. Open the generated project in TIA Portal and open **SCAMATIC_Overview** under the Unified PC target.

The generator saves a copy of the template. Its objects have static defaults and can be configured further in TIA Portal. If generation fails, PowerShell identifies the affected component. Use a fresh output folder when retrying.

## Objects and scripts

| SCAMATIC | WinCC Unified |
| --- | --- |
| Text | Native text box |
| Indicator Lamp | Ellipse with the selected initial color |
| Value Span | Output-only I/O field with a static initial value |
| Gauge | Native gauge with a static initial value |
| Button | Native button with editable caption and color |
| Industrial · Grindstone | Positioned Graphic view and a matching SVG graphic |

The export carries no SCAMATIC tags or data sources. Add engineering connections or tag bindings in TIA Portal when the project needs them. The optional scripts/wincc-template.js file includes a trace helper and an OnTapped example for each generated button. To use an example, copy its body into that button's OnTapped event in TIA Portal and customize it for your project.

## Assign Grindstone graphics

The generator positions each Graphic view using the design. If the template already contains a matching Project graphics entry, the generator assigns it. Otherwise, add the supplied assets/grindstone SVG into **Project graphics** and assign it to the generated Graphic view. In manifest.json, use **name** to find the object and **graphicName** or **file** to identify the SVG. The optional assets/schematic.svg can be imported separately as the screen background.

Review manifest.json for any skipped components or other conversion notes.

[WinCC Unified graphics](https://docs.tia.siemens.cloud/r/en-us/v21/configuring-screens-rt-unified/overview-of-screen-objects-rt-unified/graphics-rt-unified/graphics-rt-unified)
