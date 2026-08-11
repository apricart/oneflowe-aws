"use client"

import React, { useState, useRef, useEffect } from "react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

interface OTPInputProps {
  length?: number
  value: string
  onChange: (value: string) => void
  onComplete?: (value: string) => void
  disabled?: boolean
  error?: boolean
  className?: string
}

export function OTPInput({
  length = 6,
  value,
  onChange,
  onComplete,
  disabled = false,
  error = false,
  className
}: Readonly<OTPInputProps>) {
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRefs = useRef<(HTMLInputElement | null)[]>([])

  const handleChange = (index: number, inputValue: string) => {
    // Only allow single digit
    if (inputValue.length > 1) {
      inputValue = inputValue.slice(-1)
    }

    // Only allow numbers
    if (!/^\d*$/.test(inputValue)) {
      return
    }

    const newValue = value.split('')
    newValue[index] = inputValue
    const updatedValue = newValue.join('').slice(0, length)

    onChange(updatedValue)

    // Auto-focus next input
    if (inputValue && index < length - 1) {
      setActiveIndex(index + 1)
      inputRefs.current[index + 1]?.focus()
    }

    // Call onComplete when all digits are filled
    if (updatedValue.length === length && onComplete) {
      onComplete(updatedValue)
    }
  }

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace') {
      if (!value[index] && index > 0) {
        // Move to previous input if current is empty
        setActiveIndex(index - 1)
        inputRefs.current[index - 1]?.focus()
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      setActiveIndex(index - 1)
      inputRefs.current[index - 1]?.focus()
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      setActiveIndex(index + 1)
      inputRefs.current[index + 1]?.focus()
    }
  }

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault()
    const pastedData = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length)

    if (pastedData.length > 0) {
      onChange(pastedData)
      const nextIndex = Math.min(pastedData.length, length - 1)
      setActiveIndex(nextIndex)
      inputRefs.current[nextIndex]?.focus()

      if (pastedData.length === length && onComplete) {
        onComplete(pastedData)
      }
    }
  }

  useEffect(() => {
    // Focus first input on mount
    if (inputRefs.current[0]) {
      inputRefs.current[0].focus()
    }
  }, [])

  return (
    <div className={cn("flex gap-2 justify-center", className)}>
      {Array.from({ length }, (_, index) => (
        <Input
          key={index}
          ref={(el) => { inputRefs.current[index] = el }}
          type="text"
          inputMode="numeric"
          maxLength={1}
          value={value[index] || ''}
          onChange={(e) => handleChange(index, e.target.value)}
          onKeyDown={(e) => handleKeyDown(index, e)}
          onPaste={handlePaste}
          onFocus={() => setActiveIndex(index)}
          disabled={disabled}
          className={cn(
            "w-12 h-12 text-center text-lg font-semibold",
            "border-2 transition-colors",
            (() => {
              if (error) {
                return "border-red-500 bg-red-50 focus:border-red-500"
              }
              if (activeIndex === index) {
                return "border-blue-500 focus:border-blue-500"
              }
              return "border-gray-300 focus:border-blue-500"
            })(),
            disabled && "opacity-50 cursor-not-allowed"
          )}
        />
      ))}
    </div>
  )
}
