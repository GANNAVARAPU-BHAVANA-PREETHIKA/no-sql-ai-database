import { GoogleGenAI } from "@google/genai";
import { SystemState, LogEntry } from "../types";

const API_KEY = process.env.API_KEY || '';

let ai: GoogleGenAI | null = null;
if (API_KEY) {
  ai = new GoogleGenAI({ apiKey: API_KEY });
}

export const generateAIExplanation = async (
  command: string,
  resultStatus: string,
  prevState: SystemState,
  newState: SystemState
): Promise<string> => {
  if (!ai) return "AI Analysis Unavailable: API Key not configured.";

  const prompt = `
    You are an expert Distributed Systems Engineer. 
    Analyze the following operation on a NoSQL database simulation.
    
    Configuration: N=${newState.config.replicationFactor}, R=${newState.config.readQuorum}, W=${newState.config.writeQuorum}.
    
    Command: "${command}"
    Result: ${resultStatus}
    
    Context:
    - Previous Node Count: ${prevState.nodes.length}
    - New Node Count: ${newState.nodes.length}
    - Affected Data Keys: ${Object.keys(newState.data).length} total keys.
    
    Briefly explain (max 2 sentences) the technical implication of this operation, citing specific distributed systems concepts like Quorum, Consistent Hashing, Partition Tolerance, or Replication Lag where applicable.
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
    });
    return response.text || "Analysis complete.";
  } catch (error) {
    console.error("Gemini API Error:", error);
    return "AI Analysis failed to generate.";
  }
};