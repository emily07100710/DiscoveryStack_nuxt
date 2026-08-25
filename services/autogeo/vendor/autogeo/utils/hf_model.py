"""
HuggingFace model client for AutoGEO.
"""
from typing import Optional
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer
from ..evaluation.evaluator import process_prediction_text

# Global cache for model and tokenizer
_model_cache = {}
_tokenizer_cache = {}


def call_hf_model(
    user_prompt: str,
    model_path: str,
    max_new_tokens: int = 2048,
    temperature: float = 0.95,
    top_p: float = 0.7,
    top_k: int = 50,
    repetition_penalty: float = 1.0
) -> str:
    """Call HuggingFace model for inference.
    
    Args:
        user_prompt: User prompt text
        model_path: Path to HuggingFace model (can be local path or HF hub model ID)
        max_new_tokens: Maximum number of new tokens to generate
        temperature: Sampling temperature
        top_p: Top-p sampling parameter
        top_k: Top-k sampling parameter
        repetition_penalty: Repetition penalty
        
    Returns:
        Generated text from the model
        
    Raises:
        ImportError: If transformers or torch are not available
    """
    # Load or get cached model and tokenizer
    if model_path not in _model_cache:
        tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            model_path,
            torch_dtype=torch.bfloat16,
            device_map="auto",
            trust_remote_code=True
        )
        model.eval()
        
        if tokenizer.pad_token is None:
            tokenizer.pad_token = tokenizer.eos_token
        
        _model_cache[model_path] = model
        _tokenizer_cache[model_path] = tokenizer
    
    model = _model_cache[model_path]
    tokenizer = _tokenizer_cache[model_path]
    
    # Tokenize input
    inputs = tokenizer(
        user_prompt,
        return_tensors="pt",
        truncation=True,
        max_length=3000,
        padding=False
    ).to(model.device)
    
    # Generate
    with torch.no_grad():
        outputs = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            repetition_penalty=repetition_penalty,
            do_sample=True,
            pad_token_id=tokenizer.pad_token_id,
            eos_token_id=tokenizer.eos_token_id,
        )
    
    # Decode output
    input_length = inputs.input_ids.shape[1]
    generated_text = tokenizer.decode(outputs[0][input_length:], skip_special_tokens=True)
    
    # Process prediction text (similar to mini.py)
    processed_text = process_prediction_text(generated_text)
    
    return processed_text if processed_text else generated_text
