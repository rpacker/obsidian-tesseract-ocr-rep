import { App, FileSystemAdapter, ItemView, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile, Vault, WorkspaceLeaf } from 'obsidian';
import { spawn } from 'child_process';

const VIEW_TYPE_OCR = 'ocr-results-view';

interface PluginSettings {
	imagePath: string;
	tesseractLanguage: string;
	tesseractPath: string;
	debug: boolean;
	verboseOutput: boolean;
	showTesseractCommand: boolean;
	showPerFileProgress: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	imagePath: 'Meta/Attachments',
	tesseractLanguage: 'eng',
	tesseractPath: '',
	debug: false,
	verboseOutput: false,
	showTesseractCommand: false,
	showPerFileProgress: false,
}

interface ImageLink {
	match: string;
	path: string;
}

interface OcrResult {
	imageName: string;
	imagePath: string;
	noteFile: string;
	text: string;
	error?: string;
}

class OcrResultsView extends ItemView {
	private results: OcrResult[] = [];
	private plugin: TesseractOcrPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: TesseractOcrPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_OCR;
	}

	getDisplayText(): string {
		return 'OCR Results';
	}

	getIcon(): string {
		return 'scan-text';
	}

	async onOpen() {
		this.renderResults();
	}

	async onClose() {}

	setResults(results: OcrResult[]) {
		this.results = results;
		this.renderResults();
	}

	private renderResults() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.style.padding = '12px';
		container.style.overflowY = 'auto';

		const header = container.createEl('div');
		header.createEl('h4', { text: 'OCR Results', attr: { style: 'margin: 0 0 8px 0;' } });

		if (this.results.length === 0) {
			const empty = container.createEl('p', { text: 'No results yet. Run OCR to see results here.' });
			empty.style.color = 'var(--text-muted)';
			empty.style.fontStyle = 'italic';
			return;
		}

		const errors = this.results.filter(r => r.error);
		const successes = this.results.filter(r => !r.error);

		const summary = header.createEl('p');
		summary.style.margin = '0 0 4px 0';
		summary.style.color = 'var(--text-muted)';
		summary.style.fontSize = '0.85em';
		summary.setText(`${successes.length} processed, ${errors.length} error(s)`);

		const clearBtn = header.createEl('button', { text: 'Clear' });
		clearBtn.style.marginBottom = '12px';
		clearBtn.style.fontSize = '0.8em';
		clearBtn.onclick = () => {
			this.results = [];
			this.renderResults();
		};

		for (const result of this.results) {
			const item = container.createEl('div');
			item.style.marginBottom = '12px';
			item.style.padding = '8px 10px';
			item.style.borderRadius = '6px';
			item.style.border = '1px solid var(--background-modifier-border)';
			item.style.backgroundColor = result.error
				? 'rgba(var(--color-red-rgb), 0.08)'
				: 'var(--background-secondary)';

			const titleRow = item.createEl('div');
			titleRow.style.display = 'flex';
			titleRow.style.justifyContent = 'space-between';
			titleRow.style.marginBottom = '4px';

			const imageName = titleRow.createEl('strong', { text: result.imageName });
			imageName.style.fontSize = '0.9em';
			imageName.style.wordBreak = 'break-all';

			const noteName = item.createEl('div', { text: `in ${result.noteFile}` });
			noteName.style.fontSize = '0.78em';
			noteName.style.color = 'var(--text-muted)';
			noteName.style.marginBottom = '6px';

			if (result.error) {
				const errEl = item.createEl('p', { text: `Error: ${result.error}` });
				errEl.style.color = 'var(--text-error)';
				errEl.style.margin = '0';
				errEl.style.fontSize = '0.85em';
				errEl.style.wordBreak = 'break-word';
			} else if (result.text.trim() === '') {
				const empty = item.createEl('p', { text: '(no text detected)' });
				empty.style.color = 'var(--text-muted)';
				empty.style.fontStyle = 'italic';
				empty.style.margin = '0';
			} else {
				const pre = item.createEl('pre');
				pre.style.margin = '0';
				pre.style.whiteSpace = 'pre-wrap';
				pre.style.wordBreak = 'break-word';
				pre.style.fontSize = '0.82em';
				pre.style.maxHeight = '200px';
				pre.style.overflowY = 'auto';
				pre.style.backgroundColor = 'var(--background-primary)';
				pre.style.padding = '6px';
				pre.style.borderRadius = '4px';
				pre.setText(result.text.trim());
			}
		}
	}
}

export default class TesseractOcrPlugin extends Plugin {
	settings: PluginSettings;
	private lastResults: OcrResult[] = [];

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new SettingsTab(this.app, this));

		this.registerView(VIEW_TYPE_OCR, (leaf) => new OcrResultsView(leaf, this));

		this.addRibbonIcon('scan-text', 'Open OCR Results Panel', () => {
			this.activateView();
		});

		this.addCommand({
			id: 'open-ocr-panel',
			name: 'Open OCR results panel',
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: 'run',
			name: 'Run',
			callback: async () => {
				await this.runOcr();
			}
		});
	}

	onunload() {}

	async activateView() {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_OCR)[0];
		if (!leaf) {
			leaf = workspace.getRightLeaf(false)!;
			await leaf.setViewState({ type: VIEW_TYPE_OCR, active: true });
		}
		workspace.revealLeaf(leaf);
		// Push latest results into freshly opened view
		if (this.lastResults.length > 0) {
			(leaf.view as OcrResultsView).setResults(this.lastResults);
		}
	}

	private async runOcr() {
		const results: OcrResult[] = [];
		let insertionCounter = 0;
		let checkedFilesCounter = 0;
		let errorCounter = 0;

		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('OCR: scanning...');

		// --- Collect images ---
		let allImages: TAbstractFile[] = [];
		Vault.recurseChildren(this.app.vault.getRoot(), (file: TAbstractFile) => {
			if (file.path.contains(this.settings.imagePath) && this.isImage(file)) {
				allImages.push(file);
			}
		});

		if (this.settings.debug) {
			console.log(`[OCR] Found ${allImages.length} image(s) under "${this.settings.imagePath}"`);
		}

		if (allImages.length === 0) {
			new Notice(`Tesseract OCR: No images found in "${this.settings.imagePath}". Check your Image Path setting.`, 6000);
			statusBarItemEl.remove();
			return;
		}

		new Notice(`Tesseract OCR: Found ${allImages.length} image(s). Scanning notes...`);

		const files = this.getAllFiles();
		const markdownFiles = files.filter(f => this.isMarkdown(f.name));

		if (this.settings.verboseOutput) {
			new Notice(`Tesseract OCR: Checking ${markdownFiles.length} markdown file(s)...`);
		}

		// --- Process each markdown file ---
		for (const file of markdownFiles) {
			checkedFilesCounter++;
			statusBarItemEl.setText(`OCR: ${checkedFilesCounter}/${markdownFiles.length} — ${file.name}`);

			const linkRegex = /!\[\[.*\]\](?!<details>)/g;
			const content = await this.app.vault.cachedRead(file);
			let newContent = content;
			const matches = this.getImageMatches(newContent.match(linkRegex), allImages);

			if (matches.length > 0) {
				if (this.settings.debug) {
					console.log(`[OCR] ${matches.length} unprocessed image(s) in "${file.name}"`);
				}
				if (this.settings.showPerFileProgress) {
					new Notice(`OCR: Processing ${matches.length} image(s) in "${file.name}"...`);
				}
			}

			for (let i = 0; i < matches.length; i++) {
				const match = matches[i];
				const imageName = match.path.split('/').pop() ?? match.path;

				statusBarItemEl.setText(`OCR: running on ${imageName}`);

				if (this.settings.debug) {
					console.log(`[OCR] Processing image: ${match.path}`);
				}

				const index = newContent.indexOf(match.match) + match.match.length;
				try {
					const text = await this.getTextFromImage(match.path);
					const formatted = this.formatTesseractOutput(text);

					results.push({
						imageName,
						imagePath: match.path,
						noteFile: file.name,
						text: formatted,
					});

					newContent = newContent.slice(0, index) + '<details>' + formatted + '</details>\n' + newContent.slice(index);

					if (this.settings.verboseOutput) {
						new Notice(`OCR: ✓ ${imageName}`, 2000);
					}
				} catch (e) {
					const errMsg = String(e);
					console.error(`[OCR] Error on "${match.path}": ${errMsg}`);
					errorCounter++;

					results.push({
						imageName,
						imagePath: match.path,
						noteFile: file.name,
						text: '',
						error: errMsg,
					});

					new Notice(`OCR: Failed on "${imageName}". See panel for details.`, 4000);
					newContent = newContent.slice(0, index) + '<details></details>\n' + newContent.slice(index);
				}
				insertionCounter++;
			}

			if (content !== newContent) {
				if (this.settings.debug) console.log(`[OCR] Writing to: ${file.path}`);
				await this.app.vault.adapter.write(file.path, newContent);
			}
		}

		statusBarItemEl.remove();

		// --- Update sidebar panel ---
		this.lastResults = results;
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_OCR);
		for (const leaf of leaves) {
			(leaf.view as OcrResultsView).setResults(results);
		}

		// --- Final summary ---
		const okCount = insertionCounter - errorCounter;
		const summaryMsg = [
			`Tesseract OCR done.`,
			`Checked ${checkedFilesCounter} file(s).`,
			okCount > 0 ? `${okCount} image(s) inserted.` : null,
			errorCounter > 0 ? `${errorCounter} error(s) — see panel.` : null,
		].filter(Boolean).join(' ');

		new Notice(summaryMsg, 8000);

		if (this.settings.debug) {
			console.log(`[OCR] ${summaryMsg}`);
		}

		// Auto-open the panel if there are results or errors
		if (results.length > 0) {
			await this.activateView();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private getAllFiles(): TFile[] {
		let files = this.app.vault.getAllLoadedFiles();
		let onlyFiles: TFile[] = [];
		for (const f of files) {
			if (f instanceof TFile) {
				onlyFiles.push(f);
			}
		}
		return onlyFiles;
	}

	private getImageMatches(list: RegExpMatchArray | null, allImages: TAbstractFile[]): ImageLink[] {
		if (list === null) return [];
		let newList = [];
		for (let j = 0; j < list.length; j++) {
			for (let i = 0; i < allImages.length; i++) {
				if (list[j].contains(allImages[i].name)) {
					newList.push({ match: list[j], path: allImages[i].path });
				}
			}
		}
		return newList;
	}

	private isImage(file: TAbstractFile): boolean {
		return file instanceof TFile && ['jpg', 'png', 'jpeg'].includes(file.extension);
	}

	private isMarkdown(fileName: string): boolean {
		const parts = fileName.split('.');
		return parts[parts.length - 1] === 'md';
	}

	private async getTextFromImage(filePath: string): Promise<string> {
		const fullPath = (this.app.vault.adapter as FileSystemAdapter).getFullPath(filePath);
		const command = (this.settings.tesseractPath ? this.settings.tesseractPath + '/' : '') + 'tesseract';
		const commandArgs = [fullPath, '-', '-l', this.settings.tesseractLanguage];

		if (this.settings.debug || this.settings.showTesseractCommand) {
			const fullCmd = command + ' ' + commandArgs.join(' ');
			console.log(`[OCR] Command: ${fullCmd}`);
			if (this.settings.showTesseractCommand) {
				new Notice(`OCR cmd: ${fullCmd}`, 4000);
			}
		}

		return new Promise<string>((resolve, reject) => {
			let execution = spawn(command, commandArgs);

			const errorLines: string[] = [];
			const stdoutLines: string[] = [];

			execution.stderr.on('data', data => errorLines.push(data.toString()));
			execution.stdout.on('data', data => stdoutLines.push(data.toString()));
			execution.on('error', (e) => errorLines.push(e.toString()));

			execution.on('close', (code) => {
				const stdout = stdoutLines.join('');
				const stderr = errorLines.join('');

				if (this.settings.debug) {
					if (stdout) console.log(`[OCR] stdout: ${stdout}`);
					if (stderr) console.log(`[OCR] stderr: ${stderr}`);
					console.log(`[OCR] exit code: ${code}`);
				}

				if (stdout.length === 0) reject(stderr || `Tesseract exited with code ${code}`);
				else resolve(stdout);
			});
		});
	}

	private formatTesseractOutput(text: string): string {
		let returnString = '';
		let lines = text.split('\n');
		lines.forEach(element => {
			element = element.trim();
			// Remove space on numbered lists to prevent Obsidian from breaking out of <details>
			for (let i = 0; i < 10; i++) {
				element = element.replace(i + '. ', i + '.');
				element = element.replace(i + ') ', i + ')');
			}
			// Escape < and > to prevent HTML tag interpretation
			element = element.replace(/</g, '&lt;');
			element = element.replace(/>/g, '&gt;');
			// Remove markdown list markers that break <details>
			element = element.replace(/\* /g, '');
			element = element.replace(/- /g, '');

			if (element !== '') {
				returnString += element + '\n';
			}
		});
		return returnString;
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: TesseractOcrPlugin;

	constructor(app: App, plugin: TesseractOcrPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Tesseract OCR Settings' });

		// --- Core Settings ---
		containerEl.createEl('h3', { text: 'Core' });

		new Setting(containerEl)
			.setName('Image path')
			.setDesc('Folder where images are stored. Only images under this path are scanned.')
			.addText(text => text
				.setPlaceholder('Meta/Attachments')
				.setValue(this.plugin.settings.imagePath)
				.onChange(async (value) => {
					this.plugin.settings.imagePath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Tesseract path')
			.setDesc('Path to the tesseract executable. Leave empty if it is on the system PATH.')
			.addText(text => text
				.setPlaceholder('/usr/bin')
				.setValue(this.plugin.settings.tesseractPath)
				.onChange(async (value) => {
					this.plugin.settings.tesseractPath = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Tesseract language')
			.setDesc('Language pack(s) to use, e.g. "eng", "eng+deu". Must be installed on your system.')
			.addText(text => text
				.setPlaceholder('eng')
				.setValue(this.plugin.settings.tesseractLanguage)
				.onChange(async (value) => {
					this.plugin.settings.tesseractLanguage = value;
					await this.plugin.saveSettings();
				}));

		// --- Feedback Settings ---
		containerEl.createEl('h3', { text: 'Feedback & Progress' });

		new Setting(containerEl)
			.setName('Verbose output')
			.setDesc('Show a notice for each processed image and file counts before the run.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.verboseOutput)
				.onChange(async (value) => {
					this.plugin.settings.verboseOutput = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Per-file progress notices')
			.setDesc('Show a notice when starting to process images in each file.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showPerFileProgress)
				.onChange(async (value) => {
					this.plugin.settings.showPerFileProgress = value;
					await this.plugin.saveSettings();
				}));

		// --- Debug Settings ---
		containerEl.createEl('h3', { text: 'Debugging' });

		new Setting(containerEl)
			.setName('Debug logging')
			.setDesc('Log detailed information to the browser/developer console (Ctrl+Shift+I).')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debug)
				.onChange(async (value) => {
					this.plugin.settings.debug = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show tesseract command')
			.setDesc('Display the exact tesseract command as a notice when it is run. Useful for diagnosing path or argument issues.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showTesseractCommand)
				.onChange(async (value) => {
					this.plugin.settings.showTesseractCommand = value;
					await this.plugin.saveSettings();
				}));
	}
}
