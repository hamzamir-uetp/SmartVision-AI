// server.js - Complete Server Code

// Load environment variables from .env file first
require('dotenv').config();

// 1. Import required modules
const express = require('express');
const multer = require('multer');
const path = require('path');
const { ComputerVisionClient } = require('@azure/cognitiveservices-computervision');
const { BlobServiceClient } = require('@azure/storage-blob');
const { ApiKeyCredentials } = require('@azure/ms-rest-js');

// 2. Create an Express application
const app = express();
const port = process.env.PORT || 3000; // Use Azure's port or 3000 locally

// 3. Configure Multer for in-memory file upload handling
const upload = multer({ storage: multer.memoryStorage() });

// 4. Middleware to parse JSON and serve static files (for your frontend later)
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serves files from the project root

// 5. Initialize Azure Clients - We will use environment variables later
let computerVisionClient;
let blobServiceClient;
let containerClient;

// 6. Define a basic root endpoint to test the server
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html')); // This will serve your frontend
});

// 7. Health check endpoint (as per your plan)
app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working!', status: 'OK' });
});

// POST /api/analyze - Main image processing endpoint
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  // 1. Check if a file was uploaded
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No image file uploaded.' });
  }

  console.log(`📨 Analyzing a new image: ${req.file.originalname}`);

  try {
    // 2. Analyze the image with Azure Computer Vision
    const analysisResult = await analyzeImage(req.file.buffer);

    // 3. Upload the image to Azure Blob Storage
    const imageUrl = await uploadToBlobStorage(req.file.buffer, req.file.originalname);

    // 4. Send the successful response back to the frontend
    res.json({
      success: true,
      analysis: analysisResult,
      imageUrl: imageUrl
    });

  } catch (error) {
    // 5. Handle any errors that occur during the process
    console.error('❌ Analysis Error:', error);
    res.status(500).json({ success: false, error: error.message || 'Analysis failed' });
  }
});

// ----- Helper Functions for the Endpoint -----

/**
 * Analyzes an image buffer using Azure Computer Vision
 * @param {Buffer} imageBuffer - The image file in buffer format
 * @returns {Promise<Object>} The analysis results (caption, tags, text)
 */
async function analyzeImage(imageBuffer) {
  // Define the features we want from the general AI analysis
  const features = ['Description', 'Tags', 'Objects']; // Removed 'Read' from here

  // 1. Call the Azure Computer Vision API for general analysis (caption, tags, etc.)
  const analysis = await computerVisionClient.analyzeImageInStream(imageBuffer, { visualFeatures: features });

  // Format the general analysis response
  const caption = analysis.description?.captions[0]?.text || 'No caption available';
  const tags = analysis.tags?.map(tag => tag.name) || [];

  // 2. Make a SEPARATE API call for OCR (Text Extraction) using the Read API
  let text = 'No text detected';
  try {
    const readResult = await computerVisionClient.readInStream(imageBuffer, { language: 'en' });
    // The Read API is asynchronous. We need to get the result using the operation ID.
    const operationId = readResult.operationLocation.split('/').slice(-1)[0];
    
    // Wait for the OCR operation to complete
    let ocrResult;
    let attempts = 0;
    do {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
      ocrResult = await computerVisionClient.getReadResult(operationId);
      attempts++;
    } while ((ocrResult.status === 'running' || ocrResult.status === 'notStarted') && attempts < 10); // Timeout after 10 sec

    // Extract the text from the OCR result
    if (ocrResult.status === 'succeeded' && ocrResult.analyzeResult?.readResults?.[0]?.lines) {
      text = ocrResult.analyzeResult.readResults[0].lines.map(line => line.text).join(' ');
    }
  } catch (ocrError) {
    console.error('OCR Error (non-critical):', ocrError.message);
    // We don't throw the error because the main analysis might still be successful
    text = 'Text detection unavailable';
  }

  return { caption, tags, text };
}

/**
 * Uploads an image buffer to Azure Blob Storage
 * @param {Buffer} imageBuffer - The image file in buffer format
 * @param {String} originalName - The original name of the file
 * @returns {Promise<String>} The public URL of the uploaded image
 */
async function uploadToBlobStorage(imageBuffer, originalName) {
  // Create a unique filename to avoid overwriting existing files
  const timestamp = new Date().getTime();
  const safeName = originalName.replace(/[^a-zA-Z0-9.]/g, '-');
  const blobName = `${timestamp}-${safeName}`;

  // Get a reference to a block blob (the file) in the container
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  // Upload the image buffer to the blob
  await blockBlobClient.uploadData(imageBuffer);

  // Return the URL where the image can be publicly accessed
  return blockBlobClient.url;
}

// 8. Start the server and Initialize Azure Clients
app.listen(port, async () => {
  console.log(`SmartVision AI server running on http://localhost:${port}`);

  // Initialize Azure Computer Vision Client
  try {
    const cvEndpoint = process.env.COMPUTER_VISION_ENDPOINT;
    const cvKey = process.env.COMPUTER_VISION_KEY;
    const credentials = new ApiKeyCredentials({ inHeader: { 'Ocp-Apim-Subscription-Key': cvKey } });
    computerVisionClient = new ComputerVisionClient(credentials, cvEndpoint);
    console.log('✅ Azure Computer Vision client initialized');
  } catch (error) {
    console.error('❌ Failed to initialize Computer Vision client:', error.message);
  }

  // Initialize Azure Blob Storage Client
  try {
    const connectionString = process.env.BLOB_CONNECTION_STRING;
    const containerName = process.env.BLOB_CONTAINER_NAME;
    blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobServiceClient.getContainerClient(containerName);

    // Ensure the container exists
    await containerClient.createIfNotExists({ access: 'blob' });
    console.log('✅ Azure Blob Storage client initialized and container ready');
  } catch (error) {
    console.error('❌ Failed to initialize Blob Storage client:', error.message);
  }
});