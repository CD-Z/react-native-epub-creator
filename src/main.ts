import EpubFile, {
  EpubSettings,
} from '@himojuku/epub-constructor';
import JSZip from 'jszip';
import { File, Directory, Paths } from 'expo-file-system/next';

/**
 * Converts a string into a valid filename
 * @param name - The original string
 * @returns A filename-safe string
 */
export const getValidFileNameByTitle = (name: string): string => {
  if (!name || typeof name !== 'string') {
    return 'default';
  }
  return name.replace(/[^a-zA-Z0-9]/g, '_');
};

/**
 * Ensures a directory exists, creating it if necessary
 * @param path - Directory path
 * @returns The directory object or null if path is invalid
 */
const validateDir = async (path: string): Promise<Directory | null> => {
  if (!path) return null;

  try {
    const dir = new Directory(path);
    if (!dir.exists) {
      dir.create();
      console.log('Created directory:', path);
    }
    return dir;
  } catch (error) {
    console.error("Error ensuring directory exists:", path, error);
    throw error;
  }
};

/**
 * Ensures the parent directory of a file exists
 * @param filePath - Path to the file
 */
const validateParentDir = async (filePath: string): Promise<void> => {
  const dirPath = filePath.substring(0, filePath.lastIndexOf('/') + 1);
  await validateDir(dirPath);
};

/**
 * Removes a directory if it exists
 * @param path - Directory path to remove
 */
const removeDir = async (path: string) => {
  if (!path) return;

  try {
    const dir = new Directory(path);
    if (dir.exists) {
      dir.delete();
      console.log('Removed directory:', path);
    }
  } catch (error) {
    console.error("Error removing directory:", error);
  }
};

/**
 * Creates a directory structure recursively
 * @param fullPath - Complete path to create
 */
const createDirectoryRecursively = async (fullPath: string) => {
  // Ensure path is within application sandbox
  if (!fullPath.startsWith(Paths.document.uri) && !fullPath.startsWith(Paths.cache.uri)) {
    throw new Error('Path must be within application directories');
  }

  // Create directories level by level starting from application directory
  const basePath = fullPath.startsWith(Paths.document.uri) ?
    Paths.document.uri : Paths.cache.uri;
  const relativePath = fullPath.substring(basePath.length);
  const segments = relativePath.split('/').filter(segment => segment.length > 0);

  let currentPath = basePath;
  for (const segment of segments) {
    currentPath += segment + '/';
    const dir = new Directory(currentPath);
    if (!dir.exists) {
      dir.create();
    }
  }
};

/**
 * Class for building EPUB files from provided settings
 */
export default class EpubBuilder {
  private epub: EpubFile;
  private outputPath: string;
  private tempPath?: string;
  private tempOutputPath: string;
  private fileName: string;
  private dProgress: number = 0;
  private prepared: boolean = false;

  /**
   * Progress callback for monitoring EPUB creation
   */
  static onProgress?: (
    progress: number,
    epubFile: string,
    operation: 'constructEpub' | 'SaveFile' | 'Finished',
  ) => void;

  /**
   * Creates a new EPUB builder instance
   * @param settings - EPUB settings
   * @param destinationFolderPath - Where to save the final EPUB file
   */
  constructor(settings: EpubSettings, destinationFolderPath: string) {
    this.epub = new EpubFile(settings);
    this.fileName = this.epub.epubSettings.fileName || 'default';

    // Ensure path ends with a slash
    this.outputPath = destinationFolderPath.endsWith('/')
      ? destinationFolderPath
      : destinationFolderPath + '/';

    // Use document directory as temporary output location
    this.tempOutputPath = Paths.document.uri + 'temp_epub_output/';

    console.log('Constructor paths:', {
      outputPath: this.outputPath,
      tempOutputPath: this.tempOutputPath
    });
  }

  /**
   * Returns the current EPUB settings
   */
  public getEpubSettings() {
    return this.epub.epubSettings;
  }

  /**
   * Prepares the environment for EPUB creation
   * @returns The builder instance for chaining
   */
  public async prepare() {
    this.prepared = true;
    await this.createTempFolder();

    if (!this.epub.epubSettings.chapters) {
      this.epub.epubSettings.chapters = [];
    }
    
    // Clean chapter content, remove unnecessary tags
    this.sanitizeChapterContent();
    return this;
  }

  /**
   * Discards all temporary files created during the EPUB building process
   */
  public async discardChanges() {
    try {
      if (this.tempPath) {
        await removeDir(this.tempPath);
      }
      await removeDir(this.tempOutputPath);
      this.tempPath = undefined;
    } catch (error) {
      console.error("Error discarding changes:", error);
    }
  }

  /**
   * Creates temporary folders needed for the EPUB creation process
   */
  private async createTempFolder() {
    // Create safe filename
    const safeFileName = this.fileName.replace(/[^a-zA-Z0-9]/g, '_');
    
    // Use application document directory as base
    this.tempPath = Paths.document.uri + 'epub_creation/' + safeFileName + '/';
    console.log('Temp path:', this.tempPath);
    
    // Create directory structure recursively
    await createDirectoryRecursively(this.tempPath);
    
    // Create temporary output folder
    this.tempOutputPath = Paths.document.uri + 'temp_epub_output/';
    await createDirectoryRecursively(this.tempOutputPath);
  }
  
  /**
   * Populates the temporary directory with EPUB content files
   */
  private async populate(): Promise<void> {
    console.log('Populating EPUB content...');
    
    if (!this.tempPath) {
      throw new Error('Temporary path not created, please call prepare() first');
    }
    
    // Get files from epub constructor
    const files = await this.epub.constructEpub(async progress => {
      this.dProgress = progress;
      EpubBuilder.onProgress?.(progress, this.fileName, 'constructEpub');
    });
    
    console.log(`Processing ${files.length} EPUB files...`);
    
    // Process each file
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fullPath = `${this.tempPath}${file.path}`;
      
      try {
        // Update progress
        this.dProgress = ((i + 1) / files.length) * 100;
        
        console.log(`Processing ${i+1}/${files.length}: ${file.path}`);
        
        // Distinguish between directories and files
        if (file.path.endsWith('/')) {  // This is a directory
          await validateDir(fullPath);
          continue;
        }
        
        // Create parent directory for file
        await validateParentDir(fullPath);
        
        // Special handling for mimetype file
        if (file.path === 'mimetype') {
          const mimetypeFile = new File(fullPath);
          if (!mimetypeFile.exists) {
            mimetypeFile.create();
          }
          mimetypeFile.write('application/epub+zip');
          continue;
        }

        // Handle image files
        if (file.isImage && typeof file.content === 'string') {
          const sourcePath = file.content;

          const sourceFile = new File(sourcePath);
          if (sourceFile.exists) {
            const targetFile = new File(fullPath);
            if (targetFile.exists) {
              targetFile.delete();
            }
            targetFile.create();

            // Copy image file
            sourceFile.copy(new File(fullPath));
          } else {
            console.warn(`Source image not found: ${sourcePath}`);
          }
        }
        // Handle text content files
        else if (typeof file.content === 'string') {
          console.log(`Writing file: ${fullPath}`);
          const targetFile = new File(fullPath);
          if (targetFile.exists) {
            targetFile.delete();
          }
          targetFile.create();
          targetFile.write(file.content);
        }
        
        // Report progress
        EpubBuilder.onProgress?.(this.dProgress, this.fileName, 'SaveFile');
      } catch (error) {
        console.error(`Error processing file ${file.path}:`, error);
      }
    }
    
    // Remove unwanted script.js files
    const scriptPaths = [
      `${this.tempPath}script.js`,
      `${this.tempPath}EPUB/script.js`
    ];
    
    for (const scriptPath of scriptPaths) {
      const scriptFile = new File(scriptPath);
      if (scriptFile.exists) {
        scriptFile.delete();
        console.log(`Removed unnecessary script.js file: ${scriptPath}`);
      }
    }

    console.log('EPUB content population complete');
  }

  /**
   * Saves the EPUB file to the specified output path
   * @returns The full path to the saved EPUB file
   */
  public async save(): Promise<string> {
    console.log('Saving EPUB file...');
    const epubFileName = `${this.fileName}.epub`;

    if (!this.prepared) {
      await this.prepare();
    }
    try {
      await this.populate();
      await this.fixEpubStructure();
      await validateDir(this.outputPath);
      const outputFilePath = `${this.outputPath}${epubFileName}`;
      if (this.tempPath) {
        // Create a new JSZip instance
        const zip = new JSZip();
        // First add mimetype file (uncompressed)
        const mimetypeFile = new File(`${this.tempPath}mimetype`);
        if (mimetypeFile.exists) {
          const content = mimetypeFile.text();
          zip.file('mimetype', content, { compression: 'STORE' });
        }

        // Add other files according to EPUB specification order
        const epubStructure = [
          'META-INF/',
          'META-INF/container.xml',
          'OEBPS/',
          'OEBPS/content.opf',
          'OEBPS/toc.ncx'
        ];

        // First add key files (in specified order)
        for (const path of epubStructure) {
          if (path.endsWith('/')) {
            // This is a directory
            zip.folder(path);
          } else {
            const file = new File(`${this.tempPath}${path}`);
            if (file.exists) {
              const content = file.text();
              zip.file(path, content);
            }
          }
        }

        // Read all files and add to zip
        await this.addFolderToZip(zip, this.tempPath, '');

        // Generate epub file
        const content = await zip.generateAsync({
          type: 'uint8array',
          compression: 'DEFLATE',
          compressionOptions: {
            level: 9
          },
          streamFiles: false
        });
        // Write generated content to filesystem
        const outputFile = new File(outputFilePath);
        if (outputFile.exists) {
          outputFile.delete();
        }
        outputFile.create();
        outputFile.write(content);

        // Clean up temporary files
        await this.discardChanges();

        this.dProgress = 100;
        EpubBuilder.onProgress?.(this.dProgress, epubFileName, 'Finished');

        return outputFilePath;
      } else {
        throw new Error('Temporary path not set, EPUB creation failed');
      }
    } catch (error) {
      console.error("Error saving EPUB:", error);
      await this.discardChanges();
      throw error;
    }
  }
  
  /**
   * Recursively adds folder contents to zip file
   * @param zip - JSZip instance
   * @param basePath - Base path of temporary directory
   * @param relativePath - Relative path within the base path
   */
  private async addFolderToZip(zip: JSZip, basePath: string, relativePath: string): Promise<void> {
    const dir = new Directory(`${basePath}${relativePath}`);
    const items = dir.list();

    for (const item of items) {
      // Check if item is directory or file
      const isDirectory = item instanceof Directory;

      // Get item name for path building
      const itemName = item.name;
      const itemPath = relativePath ? `${relativePath}/${itemName}` : itemName;

      if (itemPath === 'mimetype') continue; // Skip mimetype (already added)
      if (itemPath === 'script.js') continue; // Skip any script.js files
      
      if (isDirectory) {
        // Process subdirectory recursively
        await this.addFolderToZip(zip, basePath, itemPath);
      } else {
        // Add file to zip
        const file = item as File;
        if (file.exists) {
          const content = file.text();
          // Check if file already exists in zip (avoid duplicates)
          if (!zip.file(itemPath)) {
            zip.file(itemPath, content);
          }
        }
      }
    }
  }

  /**
   * Sanitizes chapter content by removing unwanted tags
   */
  private sanitizeChapterContent(): void {
    if (this.epub.epubSettings.chapters) {
      this.epub.epubSettings.chapters = this.epub.epubSettings.chapters.map(chapter => {
        if (chapter.htmlBody) {
          // Remove script tags along with image tags
          const sanitizedHtml = chapter.htmlBody
            .replace(/<img[^>]*>/gi, '')
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
          return { ...chapter, htmlBody: sanitizedHtml };
        }
        return chapter;
      });
    }
  }

  /**
   * Fixes EPUB structure to ensure it's valid and follows specifications
   */
  private async fixEpubStructure(): Promise<void> {
    if (!this.tempPath) return;
    try {
        // Detect chapter files and their actual paths
        const epubPath = `${this.tempPath}EPUB/`;
        const contentDir = new Directory(`${epubPath}content/`);
        let chapterFiles: string[] = [];
        
        // Collect all chapter files
        if (contentDir.exists) {
            // If content directory exists, collect all files within it
            const items = contentDir.list();
            for (const item of items) {
                if (item instanceof File && (item.name.endsWith('.html') || item.name.endsWith('.xhtml'))) {
                    chapterFiles.push(`content/${item.name}`);
                }
            }
        } else {
            // Otherwise look for HTML/XHTML files in EPUB root
            const epubDir = new Directory(epubPath);
            const items = epubDir.list();
            for (const item of items) {
                if (item instanceof File && (item.name.endsWith('.html') || item.name.endsWith('.xhtml'))) {
                    chapterFiles.push(item.name);
                }
            }
        }

        console.log(`Found ${chapterFiles.length} chapter files:`, chapterFiles);
        
        // Find OPF file
        const opfFilePattern = /\.opf$/;
        const epubDir = new Directory(epubPath);
        const items = epubDir.list();
        let opfPath: string | null = null;

        for (const item of items) {
            if (item instanceof File && opfFilePattern.test(item.name)) {
                opfPath = `${epubPath}${item.name}`;
                break;
            }
        }

        if (!opfPath) {
            console.error('OPF file not found');
            return;
        }

        console.log(`Fixing OPF file: ${opfPath}`);
        const opfFile = new File(opfPath);
        let content = opfFile.text();
        
        // Create valid IDs for each chapter
        const idMap = new Map();
        for (let i = 0; i < chapterFiles.length; i++) {
            // Generate safe ID (no spaces or special characters)
            const chapterId = `chapter${i}`;
            idMap.set(chapterFiles[i], chapterId);
        }
        
        // Fix manifest section
        let manifestContent = '';
        const manifestRegex = /<manifest>([\s\S]*?)<\/manifest>/;
        const manifestMatch = manifestRegex.exec(content);

        if (manifestMatch) {
            manifestContent = manifestMatch[1];

            // Create new manifest content
            let newManifestContent = '';

            // Preserve CSS and NCX items
            const cssItemRegex = /<item[^>]*media-type="text\/css"[^>]*>/g;
            const cssItems = manifestContent.match(cssItemRegex) || [];
            cssItems.forEach(item => {
                newManifestContent += item + '\n';
            });
            const ncxItemRegex = /<item[^>]*media-type="application\/x-dtbncx\+xml"[^>]*>/g;
            const ncxItems = manifestContent.match(ncxItemRegex) || [];
            ncxItems.forEach(item => {
                newManifestContent += item + '\n';
            });
            
            // Add chapter items
            for (const [file, id] of idMap.entries()) {
              newManifestContent += `<item id="${id}" href="${file}" media-type="application/xhtml+xml"/>\n`;
            }
            
            // Add navigation document
            const navFile = 'toc.xhtml';
            const navFilePath = `${epubPath}${navFile}`;
            let navFileExists = new File(navFilePath).exists;
            if (!navFileExists) {
                // Try alternative nav file name
                const altNavFile = 'toc.html';
                const altNavFilePath = `${epubPath}${altNavFile}`;
                if (new File(altNavFilePath).exists) {
                    navFileExists = true;
                }
            }
            
            if (navFileExists) {
                newManifestContent += `<item id="nav" href="${navFile}" media-type="application/xhtml+xml" properties="nav"/>\n`;
            } else {
                // Create navigation file
                const navContent = this.createNavigationDocument(chapterFiles, idMap);
                const newNavFile = new File(navFilePath);
                newNavFile.create();
                newNavFile.write(navContent);
                newManifestContent += `<item id="nav" href="${navFile}" media-type="application/xhtml+xml" properties="nav"/>\n`;
            }
            
            // Update manifest section
            content = content.replace(manifestRegex, `<manifest>${newManifestContent}</manifest>`);
        }
        
        // Fix spine section
        let spineContent = '<spine toc="ncx">\n';
        for (const id of idMap.values()) {
            spineContent += `  <itemref idref="${id}"/>\n`;
        }
        spineContent += '</spine>';

        const spineRegex = /<spine[^>]*>[\s\S]*?<\/spine>/;
        content = content.replace(spineRegex, spineContent);

        // Save modified OPF file
        opfFile.write(content);
        console.log('OPF file fixing complete');

        // Fix NCX file
        const ncxPath = `${epubPath}toc.ncx`;
        if (new File(ncxPath).exists) {
            console.log('Fixing NCX file...');
            const ncxFile = new File(ncxPath);
            let ncxContent = ncxFile.text();

            // Create new navigation points
            let navMap = '<navMap>\n';
            let index = 1;
            for (const [file, id] of idMap.entries()) {
                const title = `Chapter ${index}`;
                navMap += `  <navPoint id="${id}" playOrder="${index}">\n`;
                navMap += `    <navLabel><text>${title}</text></navLabel>\n`;
                navMap += `    <content src="${file}"/>\n`;
                navMap += `  </navPoint>\n`;
                index++;
            }
            navMap += '</navMap>';

            // Replace navMap section
            ncxContent = ncxContent.replace(/<navMap>[\s\S]*?<\/navMap>/, navMap);
            ncxFile.write(ncxContent);
            console.log('NCX file fixing complete');
        }
    } catch (error) {
        console.error('Error fixing EPUB structure:', error);
        throw error;
    }
  }

  /**
   * Creates a navigation document for the EPUB
   * @param chapterFiles - Array of chapter file paths
   * @param _idMap - Map of file paths to IDs
   * @returns Navigation document content as string
   */
  private createNavigationDocument(chapterFiles: string[], _idMap: Map<string, string>): string {
    let navContent = `<?xml version="1.0" encoding="utf-8"?>
  <!DOCTYPE html>
  <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head>
    <title>Table of Contents</title>
    <meta charset="utf-8"/>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
        <h1>Table of Contents</h1>
        <ol>`;
    let index = 1;
    for (const file of chapterFiles) {
        const title = `Chapter ${index}`;
        navContent += `\n            <li><a href="${file}">${title}</a></li>`;
        index++;
    }
    navContent += `
        </ol>
    </nav>
  </body>
  </html>`;
    return navContent;
  }
}
